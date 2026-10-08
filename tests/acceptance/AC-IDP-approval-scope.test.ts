/**
 * R3-T07 PR-B 第 2 轮 P1：审批中心对 IDP 实例的管理入口按 IDP 应用的数据范围判断（DEC-043；PR 描述矩阵“审批中心”行）。
 * 审批管理员持有实例转交 / 干预 / 日志按钮、TenantBase 范围为全部，但 IDP 范围为空时：实例详情、任务与日志历史、
 * 管理员日志、转交、干预（跳转）、异常管理员交接、停用接管的替代人范围，都把 IDP 实例当作范围外（与计划详情 404 一致），
 * 节点不被改动；IDP 范围放开后同一入口恢复可见（证明判断的是 IDP 范围而不是一律拒绝 IDP）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { memberInstanceScope } from '../../apps/api/src/modules/approval/access.js';
import { planWorld, type PlanWorld } from './AC-IDP-plan-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const APV = '/api/tenant/approval';
const IDP = '/api/tenant/idp';

/** 全部允许，但 IDP 应用的“全部数据”不给（无权限提供者时范围按 data.scope.all 解析，缺省空）。 */
const withoutIdpScope: Authorizer = (request) =>
  !(request.action === 'data.scope.all' && String(request.resource ?? '').startsWith('IDP.'));

function narrowedApi(w: PlanWorld, authorize: Authorizer) {
  const api = tenantApi(w.db, { authorize, clock: w.clock });
  return (user: string, method: string, path: string, options: Parameters<typeof api.request>[2] = {}) =>
    api.request(method, path, { ...options, ...w.as(user) });
}

async function runningPlan(label: string) {
  const w = await planWorld(testDb().db, label);
  const plan = await w.startedPlan();
  const instance = await w.instanceOf(plan, 1);
  const admin = await w.member('审批管理员');
  return { w, plan, instance, admin, narrowed: narrowedApi(w, withoutIdpScope) };
}

describe('P1：审批中心的 IDP 实例按 IDP 范围判断', () => {
  it('IDP 范围为空：计划详情 404，实例详情 / 任务 / 日志 / 转交 / 跳转同样 404，节点不变', async () => {
    const { w, plan, instance, admin, narrowed } = await runningPlan('idp-apv-scope');
    expect((await narrowed(admin, 'GET', `${IDP}/plans/${plan.id}`)).status).toBe(404);
    for (const path of ['', '/tasks', '/logs']) {
      expect((await narrowed(admin, 'GET', `${APV}/instances/${instance.id}${path}`)).status, path).toBe(404);
    }
    const task = instance.tasks.find((t) => t.status === 'pending')!;
    const jump = await narrowed(admin, 'POST', `${APV}/instances/${instance.id}/admin-intervene`, {
      ifMatch: instance.revision,
      body: { kind: 'jump', toNodeKey: 'approve_plan', reason: '越权跳转' },
    });
    expect(jump.status).toBe(404);
    const transfer = await narrowed(admin, 'POST', `${APV}/instances/${instance.id}/admin-transfer`, {
      ifMatch: instance.revision,
      body: { taskId: task.id, toUserId: w.manager.userId, reason: '越权转交' },
    });
    expect(transfer.status).toBe(404);
    const after = await w.detail(instance.id);
    expect(after.revision).toBe(instance.revision);
    expect(after.tasks.filter((t) => t.status === 'pending')).toEqual([
      expect.objectContaining({ id: task.id, nodeKey: 'set_goals', assigneeUserId: w.employee.userId }),
    ]);

    // 对照：IDP 范围放开后同一管理员可见（判断的是 IDP 范围，不是一律拒绝 IDP 实例）
    const full = narrowedApi(w, () => true);
    expect((await full(admin, 'GET', `${APV}/instances/${instance.id}`)).status).toBe(200);
  });

  it('管理员日志：IDP 范围为空时不列 IDP 实例的转交记录；范围放开后列出', async () => {
    const { w, instance, admin, narrowed } = await runningPlan('idp-apv-logs');
    const task = instance.tasks.find((t) => t.status === 'pending')!;
    // 全权 HR 先做一次管理员转交，产生一条管理日志
    await w.ok(
      await w.http(w.hrUser, 'POST', `${APV}/instances/${instance.id}/admin-transfer`, {
        ifMatch: instance.revision,
        body: { taskId: task.id, toUserId: w.outsider.userId, reason: '合成转交' },
      }),
    );
    const listed = async (call: ReturnType<typeof narrowedApi>) => {
      const response = await call(admin, 'GET', `${APV}/admin-logs`);
      expect(response.status, await response.clone().text()).toBe(200);
      return JSON.stringify(await response.json()).includes(instance.id);
    };
    expect(await listed(narrowed)).toBe(false);
    expect(await listed(narrowedApi(w, () => true))).toBe(true);
  });

  it('异常管理员交接：IDP 范围为空时不改派 IDP 实例的异常待办，只计入不可识别数量', async () => {
    const w = await planWorld(testDb().db, 'idp-apv-handover');
    // 指导人没有账号：员工提交后指导人节点没有可用审批人，落到异常管理员（夹具直接解绑账号）
    const loner = await w.person('无账号指导人', w.dept);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`DELETE FROM permission_user_person_links
        WHERE tenant_id=${w.tenant.id} AND employee_id=${loner.employeeId}::uuid`),
    );
    const plan = await w.start(await w.createPlan({ tutorRole: 'other', tutorEmployeeId: loner.employeeId }));
    await w.submit(plan, 1, w.employee.userId);
    const instance = await w.instanceOf(plan, 1);
    expect(instance.tasks.find((t) => t.status === 'pending')).toMatchObject({
      assigneeUserId: w.exceptionAdmin,
      isExceptionAdmin: true,
    });
    const admin = await w.member('交接操作人');
    const successor = await w.member('新异常管理员');
    const narrowed = narrowedApi(w, withoutIdpScope);
    const response = await narrowed(admin, 'POST', `${APV}/exception-admins/handover`, {
      ifMatch: 0,
      body: { fromUserId: w.exceptionAdmin, toUserId: successor },
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(text).not.toContain(instance.id);
    expect(JSON.parse(text)).toMatchObject({ tasks: 0, unlisted: 1 });
    const after = await w.detail(instance.id);
    expect(after.tasks.find((t) => t.status === 'pending')).toMatchObject({ assigneeUserId: w.exceptionAdmin });
  });

  it('停用接管：替代人的实例范围按 IDP 范围判断（IDP 范围为空不覆盖 IDP 实例）', async () => {
    const { w, instance, admin } = await runningPlan('idp-apv-takeover');
    const covered = (authorize: Authorizer) =>
      withTenant(w.db, w.tenant.id, async (tx) => {
        const scope = await memberInstanceScope(
          { authorize, clock: w.clock } as Parameters<typeof memberInstanceScope>[0],
          { tenantId: w.tenant.id, userId: admin, timezone: 'Asia/Shanghai' },
          tx,
        );
        const result = await tx.execute(sql`SELECT count(*)::int AS hits FROM approval_instances i
          WHERE i.tenant_id=${w.tenant.id} AND i.id=${instance.id}::uuid AND ${scope}`);
        const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
        return (rows[0] as { hits: number }).hits;
      });
    expect(await covered(withoutIdpScope)).toBe(0);
    expect(await covered(() => true)).toBe(1);
  });
});
