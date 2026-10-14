/**
 * AC-TC（补，F-038 / DEC-281⑫ / Q-M0-126）：静态图格式、5 MiB 边界、登记后上传、替换与删除。
 * 只经真实 HTTP 入口；负例比较前后业务状态，命令台账与审计不保存图片字节。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { talentWorld, type TalentWorld } from './AC-TC-support.js';
import {
  animatedGif,
  animatedPng,
  attachmentStatus,
  contentPath,
  expectImageError,
  fixtureFromBytes,
  imageFixture,
  malformedPng,
  MODEL_IMAGE_AUDIT_TYPE,
  MODEL_IMAGE_LIMIT,
  modelPath,
  pngBytes,
  readModel,
  registerImage,
  uploadImage,
  type ImageExtension,
} from './AC-TC-model-image-support.js';

const testDb = useTestDb();

describe('AC-TC（补）F-038 潜力模型图格式与生命周期', () => {
  let w: TalentWorld;
  let categoryId: string;

  beforeAll(async () => {
    w = await talentWorld(testDb().db, 'model-image');
    categoryId = (await w.category()).id;
  });

  const criterion = () => w.criterion(categoryId, [], { name: `合成潜力标准 ${randomUUID()}` });

  it('初始无图，查看响应有父 revision 与标准编辑能力', async () => {
    const parent = await criterion();
    expect(await readModel(w.request, parent.id)).toEqual({
      revision: parent.revision,
      canEdit: true,
      modelImage: null,
    });
  });

  it.each<ImageExtension>(['jpeg', 'jpg', 'gif', 'png', 'bmp'])(
    '接受单帧 %s：登记不可读，上传后返回原始字节',
    async (extension) => {
      const parent = await criterion();
      const fixture = imageFixture(extension);
      const registered = await registerImage(w.request, parent.id, parent.revision, fixture);
      await expectImageError(
        await w.request('GET', contentPath(parent.id, registered.attachment.id)),
        404,
        'NOT_FOUND',
      );
      expect((await readModel(w.request, parent.id)).modelImage).toBeNull();
      const uploaded = await uploadImage(w.request, parent.id, registered, fixture);
      const response = await w.request('GET', contentPath(parent.id, registered.attachment.id));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(fixture.metadata.contentType);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture.bytes);
      expect((await readModel(w.request, parent.id)).modelImage).toEqual(uploaded.modelImage);
      expect((await w.read<{ revision: number }>(`/criteria/${parent.id}`)).revision).toBe(uploaded.revision);
    },
  );

  it('恰好 5 MiB 的有效 PNG 上传成功，多 1 字节在登记时明确 413，业务状态不变', async () => {
    const parent = await criterion();
    const maximum = fixtureFromBytes(pngBytes(MODEL_IMAGE_LIMIT));
    expect(maximum.bytes.length).toBe(MODEL_IMAGE_LIMIT);
    const registered = await registerImage(w.request, parent.id, parent.revision, maximum);
    const uploaded = await uploadImage(w.request, parent.id, registered, maximum);
    const before = await readModel(w.request, parent.id);
    const oversized = fixtureFromBytes(pngBytes(MODEL_IMAGE_LIMIT + 1));
    const response = await w.request('POST', `${modelPath(parent.id)}/attachments`, {
      ifMatch: uploaded.revision,
      body: oversized.metadata,
    });
    await expectImageError(response, 413, 'PAYLOAD_TOO_LARGE');
    expect(await readModel(w.request, parent.id)).toEqual(before);
    expect((await w.request('GET', contentPath(parent.id, registered.attachment.id))).status).toBe(200);
  });

  it('空文件拒绝 400，未知扩展名与扩展名/MIME 不一致拒绝 415，父对象不变', async () => {
    const parent = await criterion();
    const metadata = imageFixture().metadata;
    const before = await readModel(w.request, parent.id);
    const cases = [
      [{ ...metadata, byteSize: 0 }, 400, 'VALIDATION_FAILED'],
      [{ ...metadata, filename: 'model.svg', contentType: 'image/svg+xml' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [{ ...metadata, filename: 'model.webp', contentType: 'image/webp' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [{ ...metadata, filename: 'model.jpg' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [{ ...metadata, contentType: 'image/gif' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ] as const;
    for (const [body, status, code] of cases) {
      await expectImageError(
        await w.request('POST', `${modelPath(parent.id)}/attachments`, { ifMatch: parent.revision, body }),
        status,
        code,
      );
      expect(await readModel(w.request, parent.id)).toEqual(before);
    }
  });

  it('登记小图但实际解码内容超过 5 MiB 时返回 413，上传体上限不掩盖服务层校验，原图不变', async () => {
    const parent = await criterion();
    const first = await registerImage(w.request, parent.id, parent.revision);
    const firstView = await uploadImage(w.request, parent.id, first);
    const registered = await registerImage(w.request, parent.id, firstView.revision, imageFixture('bmp'));
    const before = await readModel(w.request, parent.id);
    const oversized = fixtureFromBytes(pngBytes(MODEL_IMAGE_LIMIT + 1));
    await expectImageError(
      await w.request('POST', `${modelPath(parent.id)}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: registered.revision,
        body: { base64: oversized.base64 },
      }),
      413,
      'PAYLOAD_TOO_LARGE',
    );
    expect(await readModel(w.request, parent.id)).toEqual(before);
    expect(await attachmentStatus(testDb().db, w.tenant.id, registered.attachment.id)).toBe('registered');
    expect((await w.request('GET', contentPath(parent.id, first.attachment.id))).status).toBe(200);
  });

  it.each([
    ['多帧 GIF', animatedGif],
    ['APNG', animatedPng],
    ['PNG chunk 长度越界', () => malformedPng('length')],
    ['PNG chunk CRC 不合法', () => malformedPng('crc')],
    ['伪 PNG 签名', () => fixtureFromBytes(Buffer.from('合成普通文本，不是图片'))],
  ] as const)('%s 上传拒绝 415，不关联登记对象、不增父 revision', async (_label, makeFixture) => {
    const parent = await criterion();
    const fixture = makeFixture();
    const registered = await registerImage(w.request, parent.id, parent.revision, fixture);
    const before = await readModel(w.request, parent.id);
    await expectImageError(
      await w.request('POST', `${modelPath(parent.id)}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: registered.revision,
        body: { base64: fixture.base64 },
      }),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expect(await readModel(w.request, parent.id)).toEqual(before);
    expect(await attachmentStatus(testDb().db, w.tenant.id, registered.attachment.id)).toBe('registered');
    await expectImageError(await w.request('GET', contentPath(parent.id, registered.attachment.id)), 404, 'NOT_FOUND');
  });

  it('实际内容格式与声明不一致，即使大小与哈希正确也拒绝 415', async () => {
    const parent = await criterion();
    const fixture = fixtureFromBytes(imageFixture('gif').bytes, 'png');
    const registered = await registerImage(w.request, parent.id, parent.revision, fixture);
    const before = await readModel(w.request, parent.id);
    await expectImageError(
      await w.request('POST', `${modelPath(parent.id)}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: registered.revision,
        body: { base64: fixture.base64 },
      }),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expect(await readModel(w.request, parent.id)).toEqual(before);
  });

  it.each(['size', 'sha256', 'empty', 'invalid-base64'] as const)(
    '上传 %s 不符拒绝 400，登记行与父对象不变',
    async (kind) => {
      const parent = await criterion();
      const fixture = imageFixture();
      const declared = {
        ...fixture,
        metadata: {
          ...fixture.metadata,
          ...(kind === 'size' ? { byteSize: fixture.bytes.length + 1 } : {}),
          ...(kind === 'sha256' ? { sha256: '0'.repeat(64) } : {}),
        },
      };
      const registered = await registerImage(w.request, parent.id, parent.revision, declared);
      const before = await readModel(w.request, parent.id);
      const base64 = kind === 'empty' ? '' : kind === 'invalid-base64' ? '%%%not-base64%%%' : fixture.base64;
      await expectImageError(
        await w.request('POST', `${modelPath(parent.id)}/attachments/${registered.attachment.id}/upload`, {
          ifMatch: registered.revision,
          body: { base64 },
        }),
        400,
        'VALIDATION_FAILED',
      );
      expect(await readModel(w.request, parent.id)).toEqual(before);
      expect(await attachmentStatus(testDb().db, w.tenant.id, registered.attachment.id)).toBe('registered');
    },
  );

  it('新图登记不遮掉旧图，替换成功后旧 ID 404，删图后新 ID 404，元数据留待清理', async () => {
    const parent = await criterion();
    const first = await registerImage(w.request, parent.id, parent.revision);
    const firstView = await uploadImage(w.request, parent.id, first);
    const secondFixture = imageFixture('bmp');
    const second = await registerImage(w.request, parent.id, firstView.revision, secondFixture);
    expect((await readModel(w.request, parent.id)).modelImage?.id).toBe(first.attachment.id);
    expect((await w.request('GET', contentPath(parent.id, first.attachment.id))).status).toBe(200);
    const secondView = await uploadImage(w.request, parent.id, second, secondFixture);
    await expectImageError(await w.request('GET', contentPath(parent.id, first.attachment.id)), 404, 'NOT_FOUND');
    expect(await attachmentStatus(testDb().db, w.tenant.id, first.attachment.id)).toBe('pending_cleanup');
    const deleted = await w.request('DELETE', modelPath(parent.id), { ifMatch: secondView.revision });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ revision: secondView.revision + 1, modelImage: null });
    expect((await readModel(w.request, parent.id)).modelImage).toBeNull();
    await expectImageError(await w.request('GET', contentPath(parent.id, second.attachment.id)), 404, 'NOT_FOUND');
    expect(await attachmentStatus(testDb().db, w.tenant.id, second.attachment.id)).toBe('pending_cleanup');
  });

  it('父标准删除后登记和上传对象都不能读取，附件元数据保留为 pending_cleanup', async () => {
    const parent = await criterion();
    const live = await registerImage(w.request, parent.id, parent.revision);
    const uploaded = await uploadImage(w.request, parent.id, live);
    const orphan = await registerImage(w.request, parent.id, uploaded.revision, imageFixture('bmp'));
    const deleted = await w.request('DELETE', `/criteria/${parent.id}`, { ifMatch: orphan.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    await expectImageError(await w.request('GET', modelPath(parent.id)), 404, 'NOT_FOUND');
    for (const attachment of [live.attachment, orphan.attachment]) {
      await expectImageError(await w.request('GET', contentPath(parent.id, attachment.id)), 404, 'NOT_FOUND');
      expect(await attachmentStatus(testDb().db, w.tenant.id, attachment.id)).toBe('pending_cleanup');
    }
  });

  it('显式删图也取消尚未上传的登记对象，之后不能用旧登记上传复活模型图', async () => {
    const parent = await criterion();
    const fixture = imageFixture();
    const registered = await registerImage(w.request, parent.id, parent.revision, fixture);
    const deleted = await w.request('DELETE', modelPath(parent.id), { ifMatch: registered.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const before = await readModel(w.request, parent.id);
    expect(before).toMatchObject({ revision: registered.revision + 1, modelImage: null });
    expect(await attachmentStatus(testDb().db, w.tenant.id, registered.attachment.id)).toBe('pending_cleanup');
    await expectImageError(
      await w.request('POST', `${modelPath(parent.id)}/attachments/${registered.attachment.id}/upload`, {
        ifMatch: before.revision,
        body: { base64: fixture.base64 },
      }),
      404,
      'NOT_FOUND',
    );
    expect(await readModel(w.request, parent.id)).toEqual(before);
  });

  it('revision 与命令 ID 为必填；旧 revision 或同键异内容不改图', async () => {
    const parent = await criterion();
    const fixture = imageFixture();
    const path = `${modelPath(parent.id)}/attachments`;
    await expectImageError(await w.request('POST', path, { body: fixture.metadata }), 400, 'REVISION_REQUIRED');
    await expectImageError(
      await w.request('POST', path, { ifMatch: parent.revision, body: fixture.metadata, idempotencyKey: null }),
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    const key = randomUUID();
    const registered = await registerImage(w.request, parent.id, parent.revision, fixture, key);
    const before = await readModel(w.request, parent.id);
    await expectImageError(
      await w.request('POST', path, { ifMatch: parent.revision, body: fixture.metadata }),
      409,
      'REVISION_CONFLICT',
    );
    await expectImageError(
      await w.request('POST', path, {
        ifMatch: parent.revision,
        body: { ...fixture.metadata, filename: 'changed.png' },
        idempotencyKey: key,
      }),
      409,
      'IDEMPOTENCY_CONFLICT',
    );
    expect(await readModel(w.request, parent.id)).toEqual(before);
    expect(before.revision).toBe(registered.revision);
  });

  it('登记、上传、删除重放不重复业务与审计；删除后重放上传不复活图，台账与快照无 base64', async () => {
    const parent = await criterion();
    const fixture = imageFixture();
    const registerKey = randomUUID();
    const uploadKey = randomUUID();
    const deleteKey = randomUUID();
    const registered = await registerImage(w.request, parent.id, parent.revision, fixture, registerKey);
    await registerImage(w.request, parent.id, parent.revision, fixture, registerKey);
    const uploaded = await uploadImage(w.request, parent.id, registered, fixture, uploadKey);
    await uploadImage(w.request, parent.id, registered, fixture, uploadKey);
    const deleteOptions = { ifMatch: uploaded.revision, idempotencyKey: deleteKey };
    const deleted = await w.request('DELETE', modelPath(parent.id), deleteOptions);
    expect(deleted.status).toBe(200);
    const firstDeleteBody = await deleted.json();
    const replay = await w.request('DELETE', modelPath(parent.id), deleteOptions);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstDeleteBody);
    const before = await readModel(w.request, parent.id);
    const oldUpload = await w.request(
      'POST',
      `${modelPath(parent.id)}/attachments/${registered.attachment.id}/upload`,
      {
        ifMatch: registered.revision,
        body: { base64: fixture.base64 },
        idempotencyKey: uploadKey,
      },
    );
    expect(oldUpload.status).toBe(200);
    expect(JSON.stringify(await oldUpload.json())).not.toContain(fixture.base64);
    expect(await readModel(w.request, parent.id)).toEqual(before);
    expect(before.modelImage).toBeNull();
    await expectImageError(await w.request('GET', contentPath(parent.id, registered.attachment.id)), 404, 'NOT_FOUND');
    const evidence = await withTenant(testDb().db, w.tenant.id, async (tx) => {
      const auditResult = await tx.execute(sql`SELECT action, "before", "after", changes FROM audit_events
        WHERE tenant_id=${w.tenant.id} AND object_type=${MODEL_IMAGE_AUDIT_TYPE} AND object_id=${parent.id}`);
      const ledgerResult = await tx.execute(sql`SELECT response_body FROM command_ledger
        WHERE tenant_id=${w.tenant.id} AND command_id IN (${registerKey},${uploadKey},${deleteKey})`);
      return {
        audit: Array.isArray(auditResult) ? auditResult : (auditResult as { rows: unknown[] }).rows,
        ledger: Array.isArray(ledgerResult) ? ledgerResult : (ledgerResult as { rows: unknown[] }).rows,
      };
    });
    expect(evidence.audit).toHaveLength(3);
    expect(evidence.ledger).toHaveLength(3);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(fixture.base64);
    expect(serialized).not.toContain('content_base64');
    expect(serialized).not.toContain('"base64"');
    expect(serialized).toContain(fixture.metadata.sha256);
  });
});
