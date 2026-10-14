/** F-038：真实 PostgreSQL 持父锁、两次同 revision 上传交错，只有一个业务写与成功审计。 */
import { sql, type Db, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as images from '../../apps/api/src/modules/talent/model-image-service.js';
import { talentWorld } from './AC-TC-support.js';
import {
  attachmentStatus,
  expectImageError,
  imageFixture,
  MODEL_IMAGE_AUDIT_TYPE,
  modelPath,
  readModel,
  registerImage,
} from './AC-TC-model-image-support.js';

const testDb = useTestDb();
afterEach(() => vi.restoreAllMocks());

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForParentLock(db: Db, finished: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (finished()) throw new Error('第二个写命令未等待真实父标准锁');
    const result = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%talent_criteria%'`);
    const rows = (Array.isArray(result) ? result : (result as { rows: { count: number }[] }).rows) as {
      count: number;
    }[];
    if (rows[0]!.count > 0) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('未观测到第二个命令等待父标准行锁');
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TC（补）F-038 PostgreSQL 16 强制交错', () => {
  it('先执行上传持锁未提交，另一同 revision 上传等待后 409，只有第一张图与一次成功上传审计', async () => {
    const db = testDb().db;
    const w = await talentWorld(db, 'model-image-pg');
    const category = await w.category();
    const parent = await w.criterion(category.id, []);
    const firstFixture = imageFixture();
    const secondFixture = imageFixture('bmp');
    const firstAttachment = await registerImage(w.request, parent.id, parent.revision, firstFixture);
    const secondAttachment = await registerImage(w.request, parent.id, firstAttachment.revision, secondFixture);
    const expectedRevision = secondAttachment.revision;
    const reached = signal();
    const release = signal();
    const original = images.uploadModelImage;
    vi.spyOn(images, 'uploadModelImage').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      reached.resolve();
      await release.promise;
      return result;
    });
    const upload = (attachmentId: string, base64: string) =>
      w.request('POST', `${modelPath(parent.id)}/attachments/${attachmentId}/upload`, {
        ifMatch: expectedRevision,
        body: { base64 },
      });
    const first = upload(firstAttachment.attachment.id, firstFixture.base64);
    let second: Promise<Response> | undefined;
    try {
      await Promise.race([
        reached.promise,
        first.then(() => {
          throw new Error('首个上传未到持锁屏障');
        }),
      ]);
      let secondFinished = false;
      second = upload(secondAttachment.attachment.id, secondFixture.base64).finally(() => {
        secondFinished = true;
      });
      await waitForParentLock(db, () => secondFinished);
      release.resolve();
      const [success, conflict] = await Promise.all([first, second]);
      expect(success.status, await success.clone().text()).toBe(200);
      await expectImageError(conflict, 409, 'REVISION_CONFLICT');
      expect(await readModel(w.request, parent.id)).toMatchObject({
        revision: expectedRevision + 1,
        modelImage: { id: firstAttachment.attachment.id, ...firstFixture.metadata },
      });
      expect(await attachmentStatus(db, w.tenant.id, firstAttachment.attachment.id)).toBe('uploaded');
      expect(await attachmentStatus(db, w.tenant.id, secondAttachment.attachment.id)).toBe('registered');
      const audit = await withTenant(db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT count(*)::int AS count
        FROM audit_events WHERE tenant_id=${w.tenant.id} AND object_type=${MODEL_IMAGE_AUDIT_TYPE}
        AND object_id=${parent.id} AND action='talent.criterion.model-image.upload'`),
      );
      const rows = (Array.isArray(audit) ? audit : (audit as { rows: { count: number }[] }).rows) as {
        count: number;
      }[];
      expect(rows[0]!.count).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });
});
