import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it, vi } from 'vitest';
import * as mine from '../../apps/api/src/modules/esign/mine.js';
import { notifyMessage } from '../../apps/api/src/modules/approval/notifications.js';
import { expireSignTask } from '../../apps/api/src/modules/esign/expiry.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { BASE, json, mineWorld, reason, type Receipt } from './AC-TRF-F481-s3a-support.js';

const database = useTestDb();

it('F481-09/14 未成功回执也按当前范围复核；撤范围后不能重放未生效原因', async () => {
  const w = await mineWorld(database().db, 'failed-replay');
  const b = await w.direct({ linkage: undefined, effectiveDate: '2026-10-20' });
  let all = true;
  const authorize: Authorizer = (q) => !q.action.startsWith('data.');
  registerScopeProvider(authorize, {
    scope: async () => ({ ...EMPTY_SCOPE, all, hasDataPermission: all }),
    authorize: async (q) => authorize(q),
    fields: async () => new Set(),
  });
  const request = w.restricted(authorize);
  const options = {
    idempotencyKey: crypto.randomUUID(),
    body: {
      items: [{ businessId: b.id }],
      templateIds: [w.templates[0]!.id],
    },
  };
  expect(await json(await request('POST', `${BASE}/transfer-tasks`, options))).toEqual({
    items: [{ id: b.id, ok: false, code: 'ESIGN_TRANSFER_NOT_ACTIVE' }],
  });
  all = false;
  await reason(await request('POST', `${BASE}/transfer-tasks`, options), 'NOT_FOUND', 404);
  expect(await w.tasks()).toEqual([]);
});

it('F481-08 本人兼任两节点仍须两次确认；分页先过滤本人/页签；修改模板不改变正文快照', async () => {
  const w = await mineWorld(database().db, 'same-signer');
  const b = await w.direct({ linkage: undefined });
  const reissue = () =>
    w.employee('POST', '/transfer-tasks', {
      body: {
        items: [{ businessId: b.id }],
        templateIds: [w.templates[2]!.id],
      },
    });
  const first = (await json<{ items: Receipt[] }>(await reissue())).items[0]!;
  const task = (await w.tasks())[0]!;
  expect(task.employeeSignerUserId).toBe(task.initiatorUserId);
  const content = (await w.files(task.id))[0]!.content;
  await w.call('PATCH', `/templates/${w.templates[2]!.id}`, {
    ifMatch: 1,
    body: { body: '修改后的合成模板', name: 'ZZ_F481_NEW' },
  });
  const detail = await json<{ files: { content: string }[] }>(await w.employee('GET', `/mine/${first.taskId}`));
  expect(detail.files[0]!.content).toBe(content);
  const ready = await json<{ id: string; revision: number; currentNode: string }>(await w.sign(w.employeeUser, task));
  expect(ready.currentNode).toBe('enterprise');
  expect(await w.notices()).toEqual([]);
  expect((await w.sign(w.employeeUser, ready)).status).toBe(200);
  await json(await reissue());
  const pending = await json<{ items: { id: string }[] }>(
    await w.employee('GET', '/mine?tab=pending&limit=1&offset=0'),
  );
  expect(pending.items).toHaveLength(1);
  expect(pending.items[0]!.id).not.toBe(task.id);
  expect(await json(await w.employee('GET', '/mine?tab=pending&limit=1&offset=1'))).toEqual({ items: [] });
  expect(await json(await w.employee('GET', '/mine?tab=done&limit=1&offset=0'))).toMatchObject({
    items: [{ id: task.id }],
  });
});

it('F481-10 可复用过期函数锁后重复执行一次；未到期/终态不变，零通知', async () => {
  const w = await mineWorld(database().db, 'expiry-helper');
  await w.direct();
  const [task] = await w.tasks();
  expect(await withTenant(w.db, w.tenantId, (tx) => expireSignTask(tx, w.ctx(), task!.id))).toEqual(task);
  w.setNow('2026-10-12T01:00:00Z');
  const expire = () => withTenant(w.db, w.tenantId, (tx) => expireSignTask(tx, w.ctx(), task!.id));
  const [a, b] = await Promise.all([expire(), expire()]);
  expect(a).toEqual(b);
  expect(a).toMatchObject({ status: 'expired', revision: 2 });
  expect((await w.audits(task!.id)).filter((a) => a.action === 'esign.task.expired')).toHaveLength(1);
  expect(await w.notices()).toEqual([]);
});

it('F481-13/21 通知列表按 esign 前缀分发五模板，只给接收人且业务引用正确', async () => {
  const w = await mineWorld(database().db, 'notices');
  await w.direct();
  const [task] = await w.tasks();
  // 仅测本片 listNotifications；不调用后续 S3b 提醒/撤销路由。
  const templates = [
    'esign_remind',
    'esign_revoked_employee',
    'esign_revoked_initiator',
    'esign_completed_employee',
    'esign_completed_initiator',
  ];
  await withTenant(w.db, w.tenantId, async (tx) => {
    for (const templateCode of templates)
      await notifyMessage(
        tx,
        w.ctx(),
        { businessType: 'esign_task', businessId: task!.id },
        {
          recipientUserId: w.employeeUser,
          templateCode,
          payload: {
            场景: '调动电子签署',
            文件名称: 'ZZ_F481_协议',
            员工姓名: 'ZZ_F481_EMP_01',
            截止时间: '2026-10-12 09:00',
          },
        },
      );
  });
  const result = await json<{
    items: {
      template: string;
      title: string;
      body: string;
      businessId: string;
      businessType: string;
      channel: string;
    }[];
  }>(await w.employee('GET', '/api/tenant/approval/notifications'));
  expect(result.items.map((i) => i.template).sort()).toEqual([...templates].sort());
  for (const item of result.items) {
    expect(item).toMatchObject({ businessId: task!.id, businessType: 'esign_task', channel: 'inbox' });
    expect(item.title).toMatch(/^电子签署/);
    expect(item.body).toContain('ZZ_F481_协议');
    expect(item.body).not.toMatch(/\{[^}]*\}/);
  }
  expect(await json(await w.request(w.outsider.id, 'GET', '/api/tenant/approval/notifications'))).toMatchObject({
    items: [],
  });
});

it('F481-10 确认请求等待后跨过期边界，按实际执行时间拒绝，不能沿用请求开始时钟', async () => {
  const w = await mineWorld(database().db, 'expiry-wait');
  await w.direct();
  const task = (await w.tasks())[0]!;
  let entered!: () => void;
  let release!: () => void;
  const atGuard = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = mine.ownSignTask;
  const spy = vi.spyOn(mine, 'ownSignTask').mockImplementationOnce(async (...args) => {
    const task = await original(...args);
    entered();
    await gate;
    return task;
  });
  const response = w.sign(w.employeeUser, task);
  try {
    await atGuard;
    w.setNow('2026-10-12T01:00:00Z');
    release();
    await reason(await response, 'ESIGN_TASK_EXPIRED');
  } finally {
    release();
    spy.mockRestore();
  }
  expect((await w.tasks())[0]).toMatchObject({ status: 'expired', currentNode: null, revision: 2 });
  expect(await w.notices()).toEqual([]);
});
