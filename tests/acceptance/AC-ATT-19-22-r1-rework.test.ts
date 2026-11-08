/**
 * F-479 S3 第 1 轮返工（审查 P2-1～3，针对 82409d6b4）：
 * P2-1 恢复隔离件不得被清理任务自动删字节；P2-2 失败记录与回报不带 SQL / 参数 / 文件内容；
 * P2-3 迟到的失败记录不得覆盖成功记录（真 PG 屏障测试）。关联 AC-ATT-20、AC-ATT-22。
 */
import './support/exit-gate-enforced.js';
import { PgBlobStore } from '../../apps/api/src/modules/attachments/blob-store.js';
import type { AttachmentBlobStore } from '../../apps/api/src/modules/attachments/blob-store.js';
import { runAttachmentCleanup } from '../../apps/api/src/modules/attachments/cleanup.js';
import { startAttachmentCleanupScheduler } from '../../apps/api/src/modules/attachments/cleanup-scheduler.js';
import { verifyAttachmentManifest } from '../../apps/api/src/modules/attachments/manifest.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { testDbMode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { png } from './AC-ATT-support.js';
import { exitWorld } from './AC-ATT-S2-support.js';

const database = useTestDb();
const HOUR = 3_600_000;
const at = (base: string | Date, ms: number) => new Date(new Date(base).getTime() + ms);
const SENSITIVE = ['Failed query', 'delete from', 'attachment_blobs_missing', 'PARAM-SECRET', 'CONTENT-FRAGMENT'];

const statusOf = async (db: Db, tenantId: string, id: string) =>
  rowsOf<{ status: string }>(
    await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`SELECT status FROM attachment_files WHERE tenant_id=${tenantId} AND id=${id}::uuid`),
    ),
  )[0]!.status;
const attempts = async (db: Db, tenantId: string, id: string) =>
  rowsOf<{ kind: string; status: string; attempts: number; reason: string | null }>(
    await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`SELECT kind,status,attempts,reason FROM attachment_cleanup_attempts
        WHERE tenant_id=${tenantId} AND file_id=${id}::uuid ORDER BY kind`),
    ),
  );
const bytesOf = (db: Db, tenantId: string, id: string) =>
  withTenant(db, tenantId, (tx) => PgBlobStore.read(tx, tenantId, id));
const corrupt = (db: Db, tenantId: string, id: string) =>
  withTenant(db, tenantId, async (tx) => {
    const current = (await PgBlobStore.read(tx, tenantId, id))!;
    await PgBlobStore.remove(tx, tenantId, id);
    await PgBlobStore.put(
      tx,
      tenantId,
      id,
      Uint8Array.from(current, (b, i) => (i === current.length - 1 ? b ^ 1 : b)),
    );
  });

describe('R1 P2-1 恢复隔离件不被自动删字节（AC-ATT-22 / AC-ATT-21）', () => {
  it('已绑定但未封存的草稿附件损坏 → 隔离 → 推进时钟清理 → 仍不可读、字节保留、无 purged 事件；正常解绑的照常回收', async () => {
    const { db } = database();
    const x = await exitWorld(db, 'att-r1-1');
    const tenantId = x.w.tenant.id;
    const me = await x.a.person('合成本人子');
    const [damaged, kept, unbound] = await x.uploads(me, 3);
    const draft = await x.createDraft(me, [damaged!.id, kept!.id, unbound!.id]);
    const saved = await x.w.json<{ revision: number }>(
      await x.patch(me, draft, { attachmentRefs: [damaged!.id, kept!.id] }),
    );
    expect(saved.revision).toBeGreaterThan(draft.revision);
    expect(await x.fileState(damaged!.id)).toMatchObject({ status: 'bound', sealed_at: null });
    expect((await x.fileState(unbound!.id)).status).toBe('pending_cleanup'); // 正常解绑：仍保留 business_id

    await corrupt(db, tenantId, damaged!.id);
    const now = new Date('2026-12-01T03:00:00.000Z');
    const report = await withTenant(db, tenantId, (tx) => verifyAttachmentManifest(tx, tenantId, { now }));
    expect(report.corrupted).toEqual([{ fileId: damaged!.id, problem: 'hash_mismatch' }]);
    expect((await x.a.content(me, damaged!.id)).status).toBe(404);

    await runAttachmentCleanup({ db, clock: () => at(now, 5 * HOUR), tenantId });
    await runAttachmentCleanup({ db, clock: () => at(now, 400 * 24 * HOUR), tenantId });

    expect((await x.fileState(damaged!.id)).status).toBe('pending_cleanup');
    expect(await bytesOf(db, tenantId, damaged!.id)).not.toBeNull();
    expect((await x.a.content(me, damaged!.id)).status).toBe(404);
    expect(await attempts(db, tenantId, damaged!.id)).toEqual([]);
    // 整个租户里只有“正常解绑”那一件产生 purged 事件，隔离件没有
    const purged = (await x.a.auditActions()).filter((row) => row.action === 'attachment.file.purged');
    expect(purged).toHaveLength(1);
    // 对照：正常解绑的未封存文件满 1h 后照常回收，说明排除的是“隔离件”而不是 business_id 非空的文件
    expect((await x.fileState(unbound!.id)).status).toBe('purged');
    expect(await bytesOf(db, tenantId, unbound!.id)).toBeNull();
    expect((await x.fileState(kept!.id)).status).toBe('bound');
  });
});

