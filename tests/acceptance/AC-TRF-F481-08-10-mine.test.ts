import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { grantMembership, sql, withTenant } from '@italent/db';
import * as notifications from '../../apps/api/src/modules/approval/notifications.js';
import { cmd, seedTenantWithMember } from './support/tenant-api.js';
import { BASE, json, mineWorld, reason } from './AC-TRF-F481-s3a-support.js';

const database = useTestDb();
type Mine = {
  id: string;
  revision: number;
  status: string;
  currentNode: string | null;
  completedAt: string | null;
  files: { templateId: string; templateName: string; content?: string }[];
};
const ids = (body: { items: { id: string }[] }) => body.items.map((t) => t.id);

describe('AC-TRF-F481-08/09/10/21 我的签署', () => {
  it('08 两节点按顺序确认、列表按本人待签/已签分流、正文快照和完成通知', async () => {
    const w = await mineWorld(database().db, 'flow');
    await w.direct();
    const [task] = await w.tasks();
    const pending = await json<{ items: Mine[] }>(await w.employee('GET', '/mine?tab=pending'));
    expect(ids(pending)).toEqual([task!.id]);
    expect(pending.items[0]!.files.map((f) => f.templateName)).toEqual(w.templates.slice(0, 2).map((t) => t.name));
    expect(pending.items[0]!.files.some((f) => 'content' in f)).toBe(false);
    expect(ids(await json(await w.hr('GET', '/mine?tab=pending')))).toEqual([]);
    expect(ids(await json(await w.employee('GET', '/mine?tab=done')))).toEqual([]);
    const detail = await json<Mine>(await w.employee('GET', `/mine/${task!.id}`));
    expect(detail.files.map((f) => f.content)).toEqual((await w.files(task!.id)).map((f) => f.content));
    await reason(await w.sign(w.session.user.id, task!), 'ESIGN_NODE_NOT_READY');
    await reason(await w.sign(w.outsider.id, task!), 'NOT_FOUND', 404);
    expect((await w.request(w.outsider.id, 'GET', `/mine/${task!.id}`)).status).toBe(404);
    expect(ids(await json(await w.request(w.outsider.id, 'GET', '/mine?tab=pending')))).toEqual([]);
    const employeeSigned = await json<Mine>(await w.sign(w.employeeUser, task!));
    expect(employeeSigned).toMatchObject({ currentNode: 'enterprise', revision: 2, status: 'signing' });
    expect(await w.notices()).toEqual([]);
    expect(ids(await json(await w.employee('GET', '/mine?tab=done')))).toEqual([task!.id]);
    expect(ids(await json(await w.hr('GET', '/mine?tab=pending')))).toEqual([task!.id]);
    const completed = await json<Mine>(await w.sign(w.session.user.id, employeeSigned));
    expect(completed).toMatchObject({ status: 'completed', currentNode: null, revision: 3 });
    expect(completed.completedAt).toBeTruthy();
    expect((await w.notices()).map((n) => [n.template_code, n.recipient_user_id, n.business_type])).toEqual([
      ['esign_completed_employee', w.employeeUser, 'esign_task'],
      ['esign_completed_initiator', w.session.user.id, 'esign_task'],
    ]);
    const notices = await json<{ items: { title: string; body: string; businessId: string }[] }>(
      await w.employee('GET', '/api/tenant/approval/notifications'),
    );
    expect(notices.items).toEqual([
      expect.objectContaining({
        title: '电子签署已完成',
        businessId: task!.id,
        body: `您的调动电子签署（${w.templates
          .slice(0, 2)
          .map((t) => t.name)
          .join('、')}）已签署完成，可在「我的签署」下载。`,
      }),
    ]);
    await reason(await w.sign(w.employeeUser, completed), 'ESIGN_TASK_CLOSED');
    expect((await w.audits(task!.id)).map((a) => a.action)).toEqual([
      'esign.task.completed',
      'esign.task.initiated',
      'esign.task.node_signed',
      'esign.task.node_signed',
    ]);
  });

  it('09 旧 revision 不推进；重读可提交；同键回执丢失重试不重复，异内容 409', async () => {
    const w = await mineWorld(database().db, 'replay');
    await w.direct();
    const [task] = await w.tasks();
    await reason(await w.sign(w.employeeUser, { ...task!, revision: 0 }), 'REVISION_CONFLICT');
    const fresh = await json<Mine>(await w.employee('GET', `/mine/${task!.id}`));
    const key = crypto.randomUUID();
    const first = await json<Mine>(await w.sign(w.employeeUser, fresh, key));
    expect(await json(await w.sign(w.employeeUser, fresh, key))).toEqual(first);
    await reason(await w.sign(w.employeeUser, first, key), 'IDEMPOTENCY_CONFLICT');
    const enterpriseKey = crypto.randomUUID();
    const completed = await json<Mine>(await w.sign(w.session.user.id, first, enterpriseKey));
    expect(await json(await w.sign(w.session.user.id, first, enterpriseKey))).toEqual(completed);
    expect(await w.notices()).toHaveLength(2);
    expect((await w.tasks())[0]!.revision).toBe(3);
  });

  it('09 真 HTTP 同 revision 并发只推进一次；同键并发返回同一回执', async () => {
    const w = await mineWorld(database().db, 'concurrent');
    await w.direct();
    const [task] = await w.tasks();
    const responses = await Promise.all([w.sign(w.employeeUser, task!), w.sign(w.employeeUser, task!)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    await reason(
      responses.find((r) => r.status === 409)!,
      'REVISION_CONFLICT',
    );
    const ready = (await w.tasks())[0]!;
    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([w.sign(w.session.user.id, ready, key), w.sign(w.session.user.id, ready, key)]);
    expect(await json(a)).toEqual(await json(b));
    expect(await w.notices()).toHaveLength(2);
  });

  it.each(['2026-10-12T01:00:00.000Z', '2026-10-12T01:00:00.001Z'])(
    '10 服务端到期边界 %s：409 同时提交 expired，重放无额外审计',
    async (at) => {
      const w = await mineWorld(database().db, `expiry-${at}`);
      await w.direct();
      const [task] = await w.tasks();
      w.setNow(at);
      const key = crypto.randomUUID();
      await reason(await w.sign(w.employeeUser, task!, key), 'ESIGN_TASK_EXPIRED');
      await reason(await w.sign(w.employeeUser, task!, key), 'ESIGN_TASK_EXPIRED');
      expect((await w.tasks())[0]).toMatchObject({ status: 'expired', currentNode: null, revision: 2 });
      expect(await w.notices()).toEqual([]);
      expect((await w.audits(task!.id)).map((a) => a.action)).toEqual(['esign.task.expired', 'esign.task.initiated']);
      expect(ids(await json(await w.employee('GET', '/mine?tab=pending')))).toEqual([]);
    },
  );

  it('10 到期前一毫秒可确认；终态再次确认不改变；非签署人不能触发过期', async () => {
    const w = await mineWorld(database().db, 'boundary');
    await w.direct();
    const [task] = await w.tasks();
    w.setNow('2026-10-12T00:59:59.999Z');
    const ready = await json<Mine>(await w.sign(w.employeeUser, task!));
    w.setNow('2026-10-12T01:00:00Z');
    await reason(await w.sign(w.outsider.id, ready), 'NOT_FOUND', 404);
    expect((await w.tasks())[0]!.status).toBe('signing');
    await reason(await w.sign(w.session.user.id, ready), 'ESIGN_TASK_EXPIRED');
    await reason(await w.sign(w.session.user.id, (await w.tasks())[0]!), 'ESIGN_TASK_CLOSED');
  });

  it('21 第二条通知失败，HTTP 完成、第一条通知、审计一起回滚；原命令重试成功', async () => {
    const w = await mineWorld(database().db, 'rollback');
    await w.direct();
    const [task] = await w.tasks();
    const ready = await json<Mine>(await w.sign(w.employeeUser, task!));
    const before = await w.audits(task!.id);
    const key = crypto.randomUUID();
    const spy = vi
      .spyOn(notifications, 'notifyMessage')
      .mockImplementationOnce(notifications.notifyMessage)
      .mockRejectedValueOnce(new Error('SYN_NOTIFICATION_WRITE_FAILED'));
    try {
      expect((await w.sign(w.session.user.id, ready, key)).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await w.tasks())[0]).toMatchObject({ currentNode: 'enterprise', revision: 2, status: 'signing' });
    expect(await w.notices()).toEqual([]);
    expect(await w.audits(task!.id)).toEqual(before);
    expect((await w.sign(w.session.user.id, ready, key)).status).toBe(200);
    expect((await w.sign(w.session.user.id, ready, key)).status).toBe(200);
    expect(await w.notices()).toHaveLength(2);
  });

  it('本人入口不要求对象授权；跨租户详情/确认 404；非法参数 400；分页上限 100', async () => {
    const w = await mineWorld(database().db, 'isolation');
    await w.direct();
    const [task] = await w.tasks();
    const noObject = w.restricted(() => false);
    expect((await noObject('GET', `${BASE}/mine/${task!.id}`)).status).toBe(200);
    const other = await seedTenantWithMember(w.db, 'ZZ_F481_TENANT_B');
    await grantMembership(w.db, { tenantId: other.tenant.id, userId: w.employeeUser, expectedRevision: 0 }, cmd());
    const { tenantApi } = await import('./support/tenant-api.js');
    const api = tenantApi(w.db);
    for (const method of ['GET', 'POST']) {
      const r = await api.request(method, `${BASE}/mine/${task!.id}${method === 'POST' ? '/sign' : ''}`, {
        tenant: other.tenant.id,
        user: w.employeeUser,
        ...(method === 'POST' ? { body: { revision: 1 } } : {}),
      });
      expect(r.status).toBe(404);
    }
    for (const path of ['/mine?tab=bad', '/mine?limit=101', '/mine?offset=-1', '/mine/not-a-uuid']) {
      expect((await w.hr('GET', path)).status).toBe(400);
    }
    expect(
      (await w.employee('POST', `/mine/${task!.id}/sign`, { body: { revision: 1 }, idempotencyKey: null })).status,
    ).toBe(400);
    expect((await w.employee('POST', `/mine/${task!.id}/sign`, { body: { revision: -1 } })).status).toBe(400);
    // 当前会员失效后，不能通过旧命令重放或读取签署快照。
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`UPDATE tenant_memberships SET status='revoked'
      WHERE tenant_id=${w.tenantId} AND user_id=${w.employeeUser}::uuid`),
    );
    expect((await w.employee('GET', `/mine/${task!.id}`)).status).toBe(403);
  });
});
