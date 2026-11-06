import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Person } from './AC-APV-support.js';
import { attachmentWorld, png, registration, type Receipt } from './AC-ATT-support.js';

const database = useTestDb();

describe('AC-ATT-08 幂等：同键同内容重放、同键异内容冲突', () => {
  let a: Awaited<ReturnType<typeof attachmentWorld>>;
  let actor: Person;
  beforeAll(async () => {
    a = await attachmentWorld(database().db, 'att-idem');
    actor = await a.person('测试员工甲');
  });

  it('登记：同键同内容重放同回执且只有一行；同键异内容 409', async () => {
    const key = randomUUID();
    const body = registration(png(), 'idem.png');
    const first = await a.w.json<Receipt>(await a.register(actor, body, key), 201);
    const replay = await a.w.json<Receipt>(await a.register(actor, body, key), 201);
    expect(replay).toEqual(first);
    expect(await a.fileRows(actor.userId)).toHaveLength(1);
    const changed = await a.register(actor, registration(png(), 'other.png'), key);
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('上传：同键同内容重放同回执、不重复写 blob；同键异内容 409', async () => {
    const bytes = png();
    const registered = await a.w.json<Receipt>(await a.register(actor, registration(bytes, 'up.png')), 201);
    const key = randomUUID();
    const before = await a.blobCount();
    const first = await a.w.json<Receipt>(await a.upload(actor, registered.id, bytes, registered.revision, key), 200);
    const replay = await a.w.json<Receipt>(await a.upload(actor, registered.id, bytes, registered.revision, key), 200);
    expect(replay).toEqual(first);
    expect(await a.blobCount()).toBe(before + 1);
    const changed = await a.upload(actor, registered.id, png(3, 3), registered.revision, key);
    expect(changed.status).toBe(409);
  });

  it('写请求缺 Idempotency-Key → 400；上传 / 删除缺 If-Match → 428 或 400（REVISION_REQUIRED）', async () => {
    const withoutKey = await a.api.request('POST', '/api/tenant/attachments', {
      ...a.w.as(actor.userId),
      body: registration(png()),
      idempotencyKey: null,
    });
    expect(withoutKey.status).toBe(400);
    const registered = await a.w.json<Receipt>(await a.register(actor, registration(png(), 'rev.png')), 201);
    const noMatch = await a.api.request('DELETE', `/api/tenant/attachments/${registered.id}`, a.w.as(actor.userId));
    expect(((await noMatch.json()) as { error: { code: string } }).error.code).toBe('REVISION_REQUIRED');
  });
});

describe('AC-ATT-08 / AC-ATT-23 授权：Exit.Self 按钮与 SelfExit.attachmentRefs', () => {
  let a: Awaited<ReturnType<typeof attachmentWorld>>;
  beforeAll(async () => {
    a = await attachmentWorld(database().db, 'att-perm');
  });

  it('默认授权的员工登记成功（证明字段已在目录与默认授权里）；回执无写入以外副作用', async () => {
    const mine = await a.person('测试员工甲');
    const receipt = await a.w.json<Receipt>(await a.register(mine, registration(png())), 201);
    expect(receipt.status).toBe('registered');
    const profile = await a.selfServiceProfile();
    // 默认授权 = 可见 + 可编辑；经权限配置入口重存同样的授权必须被接受（字段在目录里）
    const saved = await profile.setAttachmentField(true, true);
    expect(saved.status, await saved.clone().text()).toBe(200);
  });

  it('管理员把 attachmentRefs 改为只读后，员工登记 403 且无写入；恢复可编辑后成功', async () => {
    const mine = await a.person('测试员工乙');
    const profile = await a.selfServiceProfile();
    const readonly = await profile.setAttachmentField(true, false);
    expect(readonly.status, await readonly.clone().text()).toBe(200);
    const before = (await a.fileRows(mine.userId)).length;
    expect((await a.register(mine, registration(png()))).status).toBe(403);
    expect((await a.fileRows(mine.userId)).length).toBe(before);
    const restored = await profile.setAttachmentField(true, true);
    expect(restored.status).toBe(200);
    expect((await a.register(mine, registration(png()))).status).toBe(201);
  });

  it('关闭 Exit.Self 按钮后登记 403 且无写入', async () => {
    const mine = await a.person('测试员工丙');
    const profile = await a.selfServiceProfile();
    expect((await profile.setExitButton(false)).status).toBe(200);
    const before = (await a.fileRows(mine.userId)).length;
    expect((await a.register(mine, registration(png()))).status).toBe(403);
    expect((await a.fileRows(mine.userId)).length).toBe(before);
    expect((await profile.setExitButton(true)).status).toBe(200);
    expect((await a.register(mine, registration(png()))).status).toBe(201);
  });

  it('未绑定人员的成员（无员工档案）登记 403', async () => {
    const orphan = await a.w.member('无档案成员');
    expect((await a.register({ userId: orphan } as Person, registration(png()))).status).toBe(403);
  });

  it('同键重放不绕过撤权：撤销 Exit.Self 后重放原登记 403', async () => {
    const mine = await a.person('测试员工丁');
    const profile = await a.selfServiceProfile();
    const key = randomUUID();
    const body = registration(png(), 'replay.png');
    await a.w.json<Receipt>(await a.register(mine, body, key), 201);
    expect((await profile.setExitButton(false)).status).toBe(200);
    expect((await a.register(mine, body, key)).status).toBe(403);
    expect(await a.fileRows(mine.userId)).toHaveLength(1);
    await profile.setExitButton(true);
  });

  it('AC-ATT-23：撤字段查看权 → 元数据与内容 404“附件不存在”不回显；恢复后 200；关闭按钮 → 403；全程无写入', async () => {
    const mine = await a.person('测试员工戊');
    const profile = await a.selfServiceProfile();
    const bytes = png();
    const stored = await a.stored(mine, bytes, 'revoke.png');
    expect((await a.meta(mine, stored.id)).status).toBe(200);
    expect((await a.content(mine, stored.id)).status).toBe(200);
    const snapshot = JSON.stringify(await a.fileRows(mine.userId));
    const blobs = await a.blobCount();

    expect((await profile.setAttachmentField(false, false)).status).toBe(200);
    for (const res of [await a.meta(mine, stored.id), await a.content(mine, stored.id)]) {
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain('附件不存在');
      expect(text).not.toContain('revoke.png');
    }

    expect((await profile.setAttachmentField(true, true)).status).toBe(200);
    expect((await a.meta(mine, stored.id)).status).toBe(200);
    expect((await profile.setExitButton(false)).status).toBe(200);
    expect((await a.meta(mine, stored.id)).status).toBe(403);
    expect((await a.content(mine, stored.id)).status).toBe(403);

    expect(JSON.stringify(await a.fileRows(mine.userId))).toBe(snapshot);
    expect(await a.blobCount()).toBe(blobs);
    await profile.setExitButton(true);
  });

  it('读入口每次请求重查：员工档案解绑后读 403', async () => {
    const mine = await a.person('测试员工己');
    const stored = await a.stored(mine, png(), 'unbind.png');
    await a.unbind(mine);
    expect((await a.meta(mine, stored.id)).status).toBe(403);
    expect((await a.content(mine, stored.id)).status).toBe(403);
  });
});
