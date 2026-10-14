/** F-038 P2-1：图片写响应与幂等重放沿用标准详情页及其数据源的当前范围。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { TALENT_APP, TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { BASE as PERMISSION_BASE, seedPermissionWorld } from './AC-PRM-support.js';
import { clock, seedTalentData, talentOperator } from './AC-TC-permission-support.js';
import { TC_BASE, talentWorld } from './AC-TC-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';
import {
  contentPath,
  expectImageError,
  imageFixture,
  MODEL_IMAGE_AUDIT_TYPE,
  modelPath,
  readModel,
  registerImage,
  uploadImage,
  type ImageRequest,
} from './AC-TC-model-image-support.js';

const database = useTestDb();
const rows = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows);

describe('AC-TC（补）F-038 模型图详情范围与安全展示', () => {
  it.each(['page', 'datasource'] as const)(
    '标准 detail %s 范围收空后，首次写和旧命令重放均 404，不泄露管理员后续图或改变业务',
    async (targetKind) => {
      let world = await seedPermissionWorld(database().db);
      world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
      const data = await seedTalentData(world);
      const parent = data.inside.criterion;
      const adminRequest: ImageRequest = (method, path, options = {}) =>
        data.setup.request(method, `${TC_BASE}${path}`, { ...world.asAdmin, ...options });
      const op = await talentOperator(world, { objects: ['criterion'], mouId: data.mouId });
      const imageA = imageFixture();
      const registerKey = randomUUID();
      const uploadKey = randomUUID();
      const deleteKey = randomUUID();
      const registeredA = await registerImage(op.request, parent.id, parent.revision, imageA, registerKey);
      const uploadedA = await uploadImage(op.request, parent.id, registeredA, imageA, uploadKey);
      const deleteOptions = { ifMatch: uploadedA.revision, idempotencyKey: deleteKey };
      const deleted = await op.request('DELETE', modelPath(parent.id), deleteOptions);
      expect(deleted.status, await deleted.clone().text()).toBe(200);

      const imageB = {
        ...imageFixture(),
        metadata: { ...imageFixture().metadata, filename: 'administrator-model-b.png' },
      };
      const afterDelete = await readModel(adminRequest, parent.id);
      const registeredB = await registerImage(adminRequest, parent.id, afterDelete.revision, imageB);
      const uploadedB = await uploadImage(adminRequest, parent.id, registeredB, imageB);
      const pending = await registerImage(op.request, parent.id, uploadedB.revision);
      const liveB = await readModel(adminRequest, parent.id);
      expect(liveB.modelImage).toEqual(uploadedB.modelImage);

      const code = TALENT_OBJECTS.criterion.code;
      const policy = await world.api.request(
        'PUT',
        `${PERMISSION_BASE}/scope-policies/${TALENT_APP}/${code}/${targetKind}/${code}.detail`,
        { ...world.asAdmin, ifMatch: 0, body: { rules: [] } },
      );
      expect(policy.status, await policy.clone().text()).toBe(200);
      await expectImageError(await op.request('GET', `/criteria/${parent.id}`), 404, 'NOT_FOUND');
      await expectImageError(await op.request('GET', modelPath(parent.id)), 404, 'NOT_FOUND');
      await expectImageError(
        await op.request('GET', contentPath(parent.id, registeredB.attachment.id)),
        404,
        'NOT_FOUND',
      );

      const snapshot = async () => {
        const model = await readModel(adminRequest, parent.id);
        const stored = await withTenant(world.db, world.tenant.id, async (tx) => {
          const attachments = await tx.execute(sql`SELECT id, status, filename, content_type, byte_size, sha256,
            md5(content_base64) AS content_digest FROM talent_model_image_attachments
            WHERE tenant_id=${world.tenant.id} AND criterion_id=${parent.id} ORDER BY id`);
          const audit = await tx.execute(sql`SELECT count(*)::int AS count FROM audit_events
            WHERE tenant_id=${world.tenant.id} AND object_type=${MODEL_IMAGE_AUDIT_TYPE} AND object_id=${parent.id}`);
          const ledger = await tx.execute(sql`SELECT count(*)::int AS count FROM command_ledger
            WHERE tenant_id=${world.tenant.id}`);
          return { attachments: rows(attachments), audit: rows(audit), ledger: rows(ledger) };
        });
        return { model, ...stored };
      };

      const denied = async (method: string, path: string, options: RequestOptions) => {
        const before = await snapshot();
        const response = await op.request(method, path, options);
        const body = (await response.json()) as { error?: { code: string } };
        expect.soft(response.status, `${method} ${path}: ${JSON.stringify(body)}`).toBe(404);
        expect.soft(body.error?.code, `${method} ${path}`).toBe('NOT_FOUND');
        const serialized = JSON.stringify(body);
        expect.soft(serialized).not.toContain(registeredB.attachment.id);
        expect.soft(serialized).not.toContain(imageB.metadata.filename);
        expect.soft(serialized).not.toContain('"modelImage"');
        expect.soft(serialized).not.toContain('"attachment"');
        expect.soft(await snapshot(), `${method} ${path} 不改变父 revision、图片、审计或命令台账`).toEqual(before);
      };

      // 原命令已成功，但当前详情不可读；台账命中不能跳过详情范围。
      await denied('POST', `${modelPath(parent.id)}/attachments`, {
        ifMatch: parent.revision,
        body: imageA.metadata,
        idempotencyKey: registerKey,
      });
      await denied('POST', `${modelPath(parent.id)}/attachments/${registeredA.attachment.id}/upload`, {
        ifMatch: registeredA.revision,
        body: { base64: imageA.base64 },
        idempotencyKey: uploadKey,
      });
      await denied('DELETE', modelPath(parent.id), deleteOptions);

      // 每次首次写都带当前 revision，避免旧版本冲突遮住详情范围缺口。
      await denied('POST', `${modelPath(parent.id)}/attachments`, {
        ifMatch: (await readModel(adminRequest, parent.id)).revision,
        body: imageFixture().metadata,
      });
      await denied('POST', `${modelPath(parent.id)}/attachments/${pending.attachment.id}/upload`, {
        ifMatch: (await readModel(adminRequest, parent.id)).revision,
        body: { base64: imageFixture().base64 },
      });
      await denied('DELETE', modelPath(parent.id), {
        ifMatch: (await readModel(adminRequest, parent.id)).revision,
      });
      expect.soft(await readModel(adminRequest, parent.id)).toEqual(liveB);
    },
  );

  it('已验权的图片内容显式 inline，保留 MIME、nosniff 与私有禁止缓存响应头', async () => {
    const world = await talentWorld(database().db, 'model-image-inline');
    const category = await world.category();
    const parent = await world.criterion(category.id, []);
    const fixture = imageFixture();
    const registered = await registerImage(world.request, parent.id, parent.revision, fixture);
    await uploadImage(world.request, parent.id, registered, fixture);
    const content = await world.request('GET', contentPath(parent.id, registered.attachment.id));
    expect(content.status, await content.clone().text()).toBe(200);
    expect(content.headers.get('Content-Disposition')).toBe('inline');
    expect(content.headers.get('Content-Type')).toBe('image/png');
    expect(content.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(content.headers.get('Cache-Control')).toBe('private, no-store');
    expect(Buffer.from(await content.arrayBuffer())).toEqual(fixture.bytes);
  });
});
