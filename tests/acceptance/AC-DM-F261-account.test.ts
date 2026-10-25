/** F-261 / DEC-684：只经真实离退休、改期与调度入口验证账号生命周期。 */
import './support/exit-gate-enforced.js';
import { getUser, setUserStatus, grantMembership, revokeMembership, sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { rehireWorld } from './AC-RT-rehire-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const world = (label: string) => downstreamWorld(database().db, `f261-${label}`);
type World = Awaited<ReturnType<typeof world>>;
const early = { earlyEnabled: true, basis: 'actual_leave_date', time: '19:00', inReview: false };
async function ok(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json();
}
async function configure(x: World, value = early) {
  const current = await ok(await x.session.request('GET', '/exit-account/settings'));
  return ok(await x.session.request('PUT', '/exit-account/settings', { ifMatch: current.revision, body: value }));
}
async function account(x: World) {
  const userId = await x.applicantAccount(x.employee.id);
  return (await getUser(database().db, userId))!;
}
async function create(x: World, last = '2026-10-15', mode: 'direct' | 'application' = 'direct', exit = {}) {
  return x.createdLeave(x.employee.id, leaveBody(last, mode, { exitTypeCode: 'voluntary', ...exit }));
}
async function changeDate(x: World, id: string, lastWorkDate: string) {
  return ok(
    await x.session.request('PATCH', `/exits/${id}`, {
      ifMatch: (await x.business(id)).revision,
      body: { lastWorkDate },
    }),
  );
}
async function cancel(x: World, id: string) {
  return ok(
    await x.session.request('POST', `/exits/${id}/cancel`, {
      ifMatch: (await x.business(id)).revision,
      body: { reason: '合成撤销原因' },
    }),
  );
}

describe('F-261 默认生效与账号关联', () => {
  it('源租户成员关系先撤销时，离职仍停用绑定的全局账号，另一租户不能继续登录', async () => {
    const x = await world('revoked-source');
    const y = await world('revoked-other');
    const user = await account(x);
    await grantMembership(
      database().db,
      {
        tenantId: y.session.tenant.id,
        userId: user.id,
        expectedRevision: 0,
      },
      cmd(),
    );
    await revokeMembership(
      database().db,
      {
        tenantId: x.session.tenant.id,
        userId: user.id,
        expectedRevision: 1,
      },
      cmd(),
    );
    const leave = await create(x);
    await x.runScheduler('2026-10-16T02:00:00Z');
    expect((await x.business(leave.id)).status).toBe('effective');
    expect((await account(x)).status).toBe('disabled');
  });

  it('默认提前停用关闭；未来离职不影响账号，生效后全局停用，重复调度幂等，关联完整保留', async () => {
    const x = await world('default');
    const before = await account(x);
    const links = await x.sqlRows(sql`SELECT * FROM permission_user_person_links
      WHERE tenant_id=${x.session.tenant.id} AND employee_id=${x.employee.id}::uuid`);
    const leave = await create(x);
    expect((await account(x)).status).toBe('active');
    await x.runScheduler('2026-10-16T02:00:00Z');
    expect((await x.business(leave.id)).status).toBe('effective');
    const disabled = await account(x);
    expect(disabled.status).toBe('disabled');
    expect(disabled.id).toBe(before.id);
    expect(disabled.email).toBe(before.email);
    expect(
      await x.sqlRows(sql`SELECT * FROM permission_user_person_links
      WHERE tenant_id=${x.session.tenant.id} AND employee_id=${x.employee.id}::uuid`),
    ).toEqual(links);
    await x.runScheduler('2026-10-16T03:00:00Z');
    expect(await account(x)).toEqual(disabled);
  });

  it.each([false, true])('退休同时返聘=%s：仅不返聘时停用，保留账号 ID', async (reEmployed) => {
    const x = await rehireWorld(database().db, `f261-retire-${reEmployed}`);
    const before = await account(x);
    await ok(
      await x.postRehire(
        reEmployed
          ? x.rehireBody('2026-10-04')
          : {
              mode: 'direct',
              lastWorkDate: '2026-10-04',
            },
      ),
      201,
    );
    expect((await account(x)).id).toBe(before.id);
    expect((await account(x)).status).toBe(reEmployed ? 'active' : 'disabled');
  });

  it('直接保存已经到生效日时，请求返回前停用；尚未生效撤销不改变账号', async () => {
    const x = await world('immediate-effective');
    await create(x, '2026-10-04');
    expect((await account(x)).status).toBe('disabled');
    const y = await world('cancel-future');
    const before = await account(y);
    const leave = await create(y);
    await cancel(y, leave.id);
    expect(await account(y)).toEqual(before);
  });
});

describe('AC-DM-04 提前停用', () => {
  it('实际离岗日 19:00（租户时区）边界，最后工作日仍在未来；重复调度不重复写账号', async () => {
    const x = await world('clock');
    await configure(x);
    const leave = await create(x, '2026-10-15', 'direct', { actualLeaveDate: '2026-10-06' });
    await x.runScheduler('2026-10-06T10:59:59Z');
    expect((await account(x)).status).toBe('active');
    await x.runScheduler('2026-10-06T11:00:00Z');
    expect((await x.business(leave.id)).status).toBe('approved');
    const disabled = await account(x);
    expect(disabled.status).toBe('disabled');
    await x.runScheduler('2026-10-06T11:01:00Z');
    expect(await account(x)).toEqual(disabled);
  });

  it.each(['last_work_date', 'actual_leave_date'])(
    '基准 %s，未填实际离岗日取最后工作日；过点保存立即停用',
    async (basis) => {
      const x = await world(`past-${basis}`);
      await configure(x, { ...early, basis });
      x.setNow('2026-10-06T11:01:00Z');
      await create(x, '2026-10-06');
      expect((await account(x)).status).toBe('disabled');
    },
  );

  it.each([false, true])('审批中开关=%s：草稿不停用，提交过点按开关停用', async (inReview) => {
    const x = await world(`review-${inReview}`);
    await configure(x, { ...early, inReview });
    x.setNow('2026-10-06T11:01:00Z');
    const leave = await create(x, '2026-10-15', 'application', { actualLeaveDate: '2026-10-06' });
    expect((await account(x)).status).toBe('active');
    await ok(
      await x.session.request('POST', `/businesses/${leave.id}/submit`, {
        ifMatch: leave.revision,
        body: {},
      }),
    );
    expect((await account(x)).status).toBe(inReview ? 'disabled' : 'active');
    if (!inReview) {
      const [task] = await x.sqlRows<{ id: string; userId: string; revision: number }>(sql`
        SELECT t.id,t.assignee_user_id AS "userId",i.revision FROM approval_tasks t
        JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
        WHERE t.tenant_id=${x.session.tenant.id} AND i.business_id=${leave.id}::uuid AND t.status='pending'`);
      const api = tenantApi(database().db, { clock: () => new Date('2026-10-06T11:02:00Z') });
      await ok(
        await api.request('POST', `/api/tenant/approval/tasks/${task!.id}/approve`, {
          tenant: x.session.tenant.id,
          user: task!.userId,
          ifMatch: task!.revision,
          body: {},
        }),
      );
      expect((await account(x)).status).toBe('disabled');
    }
  });
});

describe('AC-DM-05 自动停用来源与真实改期', () => {
  it('实际离岗日基准改晚也恢复；同一账号恢复后再次通过租户认证', async () => {
    const x = await world('actual-replan');
    await configure(x);
    x.setNow('2026-10-06T11:01:00Z');
    const user = await account(x);
    const leave = await create(x, '2026-10-20', 'direct', { actualLeaveDate: '2026-10-06' });
    expect((await account(x)).status).toBe('disabled');
    const api = tenantApi(database().db);
    const authenticate = () =>
      api.request('GET', '/api/tenant/employment/exit-account/tasks', {
        tenant: x.session.tenant.id,
        user: user.id,
      });
    expect((await authenticate()).status).toBe(401);
    await ok(
      await x.session.request('PATCH', `/exits/${leave.id}`, {
        ifMatch: (await x.business(leave.id)).revision,
        body: { actualLeaveDate: '2026-10-18' },
      }),
    );
    expect((await account(x)).status).toBe('active');
    expect((await authenticate()).status).toBe(200);
    await x.runScheduler('2026-10-18T11:00:00Z');
    expect((await account(x)).status).toBe('disabled');
    expect((await x.business(leave.id)).status).toBe('approved');
  });

  it.each([false, true])('未生效改晚：手工再次停用=%s，仅恢复仍由本规则停用的账号', async (manual) => {
    const x = await world(`replan-${manual}`);
    await configure(x, { ...early, basis: 'last_work_date' });
    x.setNow('2026-10-06T11:01:00Z');
    const leave = await create(x, '2026-10-06');
    const disabled = await account(x);
    expect(disabled.status).toBe('disabled');
    if (manual)
      await setUserStatus(
        database().db,
        {
          userId: disabled.id,
          status: 'disabled',
          expectedRevision: disabled.revision,
        },
        cmd(),
      );
    await changeDate(x, leave.id, '2026-10-20');
    expect((await account(x)).status).toBe(manual ? 'disabled' : 'active');
  });

  it('已生效重定位仍早于今天保持停用；替代到未来恢复，后继到期再次停用，撤销再次恢复', async () => {
    const x = await world('replacement');
    const leave = await create(x, '2026-10-15');
    await x.runScheduler('2026-10-16T02:00:00Z');
    expect((await account(x)).status).toBe('disabled');
    x.setNow('2026-11-05T02:00:00Z');
    await changeDate(x, leave.id, '2026-10-25');
    expect((await account(x)).status).toBe('disabled');
    const replaced = await changeDate(x, leave.id, '2026-11-20');
    expect(replaced.successor.id).toBeTruthy();
    expect((await account(x)).status).toBe('active');
    await x.runScheduler('2026-11-21T02:00:00Z');
    expect((await account(x)).status).toBe('disabled');
    x.setNow('2026-11-21T03:00:00Z');
    await cancel(x, replaced.successor.id);
    expect((await account(x)).status).toBe('active');
  });

  it.each([false, true])('提前停用前已手工停用=%s，撤销只恢复本规则账号', async (manual) => {
    const x = await world(`cancel-${manual}`);
    if (manual) {
      const user = await account(x);
      await setUserStatus(
        database().db,
        { userId: user.id, status: 'disabled', expectedRevision: user.revision },
        cmd(),
      );
    }
    await configure(x, { ...early, basis: 'last_work_date' });
    x.setNow('2026-10-06T11:01:00Z');
    const leave = await create(x, '2026-10-06');
    expect((await account(x)).status).toBe('disabled');
    await cancel(x, leave.id);
    expect((await account(x)).status).toBe(manual ? 'disabled' : 'active');
  });
});
