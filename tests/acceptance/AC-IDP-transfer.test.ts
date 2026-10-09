/**
 * F-066（docs/02_业务建模/28 补充“流程干预”，Q-M0-115 ⑥；IDP-R16）：HR / 计划所有者对计划的“转交”干预——
 * 复用审批 adminAct 的 transfer，把当前运行阶段审批实例的当前待办转给他人。
 * 权限与范围同跳转 / 催办：按钮 transfer + 数据范围（范围外 404）+ revision + 幂等；本人回避按 DEC-321 与
 * F-048 §6 #17 / #20：所有者可干预，计划员工本人（冻结的 U(S)）回避，不查实时绑定；目标校验交给 adminAct。
 * 负例前后比对不变。
 */
import { eq, permissionUserPersonLinks, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import { errorOf, permissionWorldOf, planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';

/** 计划上的干预审计（与 AC-IDP-owner-intervention 同口径）。 */
async function interventionLogs(w: PlanWorld, planId: string) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT actor_user_id, before, after FROM audit_events
      WHERE tenant_id = ${w.tenant.id} AND object_id = ${planId} AND after->>'intervention' IS NOT NULL
      ORDER BY occurred_at, id`);
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      actor_user_id: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }[];
    return rows;
  });
}

/** 审批侧的转交审计（原审批人、新审批人、原因齐全，DEC-063）。 */
async function approvalTransferLogs(w: PlanWorld, instanceId: string) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT after FROM audit_events WHERE tenant_id = ${w.tenant.id}
      AND object_id = ${instanceId} AND action = 'approval.admin.transfer'`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      after: { assigneeUserId?: string; reason?: string | null };
    }[];
  });
}

const transfer = (
  w: PlanWorld,
  plan: Pick<PlanView, 'id' | 'revision'>,
  body: Record<string, unknown>,
  actor = w.hrUser,
  extra: { idempotencyKey?: string; ifMatch?: number } = {},
) =>
  w.http(actor, 'POST', `${IDP}/plans/${plan.id}/transfer`, {
    ifMatch: extra.ifMatch ?? plan.revision,
    body,
    ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}),
  });

/** 制定计划阶段：员工提交后待办在指导人（经理甲）。 */
async function atApprovePlan(label: string) {
  const w = await planWorld(testDb().db, label);
  const started = await w.startedPlan();
  const plan = await w.submit(started, 1, w.employee.userId);
  return { w, plan };
}

/** 可信夹具：把计划员工的账号绑定换成所有者。 */
async function rebindToOwner(w: PlanWorld) {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.delete(permissionUserPersonLinks).where(eq(permissionUserPersonLinks.employeeId, w.employee.employeeId));
    await tx
      .insert(permissionUserPersonLinks)
      .values({ tenantId: w.tenant.id, userId: w.hrUser, employeeId: w.employee.employeeId });
  });
}

describe('AC-IDP（补）F-066 转交：成功路径', () => {
  it('所有者转交当前待办：原待办关闭、新审批人收到待办，计划 revision +1，计划审计与审批审计各一条', async () => {
    const { w, plan } = await atApprovePlan('idp-tr-ok');
    const before = await w.instanceOf(plan, 1);
    const pending = before.tasks.filter((t) => t.status === 'pending');
    expect(pending.map((t) => t.assigneeUserId)).toEqual([w.manager.userId]);

    const response = await transfer(w, plan, { toUserId: w.outsider.userId, reason: '经理休假，改由丙处理' });
    expect(response.status, await response.clone().text()).toBe(200);

    const after = await w.instanceOf(await w.readPlan(plan.id), 1);
    expect(after.tasks.filter((t) => t.status === 'pending').map((t) => t.assigneeUserId)).toEqual([w.outsider.userId]);
    expect(after.tasks.find((t) => t.id === pending[0]!.id)).toMatchObject({ status: 'transferred' });
    expect((await w.readPlan(plan.id)).revision).toBe(plan.revision + 1);

    const logs = await interventionLogs(w, plan.id);
    expect(logs).toEqual([
      expect.objectContaining({
        actor_user_id: w.hrUser,
        after: expect.objectContaining({ intervention: 'transfer', reason: '经理休假，改由丙处理' }),
      }),
    ]);
    expect(await approvalTransferLogs(w, before.id)).toEqual([
      expect.objectContaining({
        after: expect.objectContaining({ assigneeUserId: w.outsider.userId, reason: '经理休假，改由丙处理' }),
      }),
    ]);
  });

  it('计划审计的前后值只含计划对象登记的字段（不带审批人账号）', async () => {
    const { w, plan } = await atApprovePlan('idp-tr-audit-fields');
    await w.ok(await transfer(w, plan, { toUserId: w.outsider.userId }));
    const [log] = await interventionLogs(w, plan.id);
    const registered = ['intervention', 'reason', 'stageId', 'toNodeKey', 'status'];
    expect(Object.keys(log!.after!).every((key) => registered.includes(key))).toBe(true);
    expect(Object.keys(log!.before ?? {}).every((key) => registered.includes(key))).toBe(true);
    expect(JSON.stringify(log)).not.toContain(w.outsider.userId);
  });

  it('当前阶段有多个待办时须指定 taskId；taskId 不属于该实例的待办 409，业务不变', async () => {
    const { w, plan } = await atApprovePlan('idp-tr-task');
    const instance = await w.instanceOf(plan, 1);
    const bad = await transfer(w, plan, {
      toUserId: w.outsider.userId,
      taskId: '00000000-0000-4000-8000-000000000001',
    });
    expect(await errorOf(bad)).toMatchObject({ status: 409, reason: 'APPROVAL_TASK_CLOSED' });
    const taskId = instance.tasks.find((t) => t.status === 'pending')!.id;
    const good = await transfer(w, plan, { toUserId: w.outsider.userId, taskId });
    expect(good.status, await good.clone().text()).toBe(200);
  });
});

describe('AC-IDP（补）F-066 转交：权限、范围与状态（DEC-067 revision / 幂等）', () => {
  it('范围内且有按钮权的 HR 成功；无按钮整次 403；范围外 404；业务与审计不变', async () => {
    const { w, plan } = await atApprovePlan('idp-tr-perm');
    const pw = await permissionWorldOf(w);
    const noButton = await idpOperator(pw, { orgId: w.dept, buttons: false });
    const denied = await noButton.request('POST', `/plans/${plan.id}/transfer`, {
      ifMatch: plan.revision,
      body: { toUserId: w.outsider.userId },
    });
    expect(denied.status).toBe(403);
    const outside = await idpOperator(pw, { orgId: await w.org('范围外部门') });
    const hidden = await outside.request('POST', `/plans/${plan.id}/transfer`, {
      ifMatch: plan.revision,
      body: { toUserId: w.outsider.userId },
    });
    expect(hidden.status).toBe(404);
    expect(await w.readPlan(plan.id)).toMatchObject({ revision: plan.revision });
    expect(await interventionLogs(w, plan.id)).toEqual([]);

    const inside = await idpOperator(pw, { orgId: w.dept });
    const done = await inside.request('POST', `/plans/${plan.id}/transfer`, {
      ifMatch: plan.revision,
      body: { toUserId: w.outsider.userId, reason: '范围内 HR 转交' },
    });
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await interventionLogs(w, plan.id)).toEqual([
      expect.objectContaining({
        actor_user_id: inside.as.user,
        after: expect.objectContaining({ intervention: 'transfer' }),
      }),
    ]);
  });

  it('计划没有运行阶段（未开始 / 已终止）：409 IDP_NO_RUNNING_STAGE，计划不变', async () => {
    const w = await planWorld(testDb().db, 'idp-tr-idle');
    const idle = await w.createPlan({ name: '未开始' });
    const response = await transfer(w, idle, { toUserId: w.outsider.userId });
    expect(await errorOf(response)).toMatchObject({ status: 409, reason: 'IDP_NO_RUNNING_STAGE' });
    expect(await w.readPlan(idle.id)).toMatchObject({ status: 'not_started', revision: idle.revision });

    const running = await w.startedPlan({ name: '将终止' });
    await w.ok(
      await w.intervene('terminate', { items: [{ id: running.id, revision: running.revision }], reason: '作废' }),
    );
    const ended = await w.readPlan(running.id);
    const again = await transfer(w, ended, { toUserId: w.outsider.userId });
    expect(await errorOf(again)).toMatchObject({ status: 409, reason: 'IDP_NO_RUNNING_STAGE' });
    expect(await w.readPlan(running.id)).toMatchObject({ status: 'terminated', revision: ended.revision });
  });

  it('revision 不一致 409 REVISION_CONFLICT；缺 If-Match 400；缺 toUserId 400；业务不变', async () => {
    const { w, plan } = await atApprovePlan('idp-tr-rev');
    const stale = await transfer(w, plan, { toUserId: w.outsider.userId }, w.hrUser, { ifMatch: plan.revision + 9 });
    expect(await errorOf(stale)).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    const noMatch = await w.http(w.hrUser, 'POST', `${IDP}/plans/${plan.id}/transfer`, {
      body: { toUserId: w.outsider.userId },
    });
    expect(noMatch.status).toBe(400);
    const noTarget = await transfer(w, plan, {});
    expect(noTarget.status).toBe(400);
    expect(await w.readPlan(plan.id)).toMatchObject({ revision: plan.revision });
    expect((await w.instanceOf(plan, 1)).tasks.filter((t) => t.status === 'pending')).toHaveLength(1);
    expect(await interventionLogs(w, plan.id)).toEqual([]);
  });

  it('幂等：同键同内容重放返回原结果且不重复转交 / 审计；同键异内容 409', async () => {
    const { w, plan } = await atApprovePlan('idp-tr-idem');
    const key = '11111111-1111-4111-8111-111111111111';
    const body = { toUserId: w.outsider.userId, reason: '幂等' };
    const first = await transfer(w, plan, body, w.hrUser, { idempotencyKey: key });
    expect(first.status, await first.clone().text()).toBe(200);
    const replay = await transfer(w, plan, body, w.hrUser, { idempotencyKey: key });
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await interventionLogs(w, plan.id)).toHaveLength(1);
    expect((await w.readPlan(plan.id)).revision).toBe(plan.revision + 1);
    const conflict = await transfer(w, plan, { ...body, reason: '另一个原因' }, w.hrUser, { idempotencyKey: key });
    expect(await errorOf(conflict)).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('AC-IDP（补）F-066 转交：本人回避（DEC-321 / F-048 §6 #17 #20）', () => {
  it('计划员工本人（非所有者）转交自己计划的待办：403 APPROVAL_ADMIN_SELF，计划与审计不变', async () => {
    const { w, plan } = await atApprovePlan('idp-tr-self');
    const response = await transfer(w, plan, { toUserId: w.outsider.userId }, w.employee.userId);
    expect(await errorOf(response)).toMatchObject({ status: 403, reason: 'APPROVAL_ADMIN_SELF' });
    expect(await w.readPlan(plan.id)).toMatchObject({ revision: plan.revision });
    expect(await interventionLogs(w, plan.id)).toEqual([]);
  });

  it('冻结前所有者已绑定为计划员工：403；冻结后才首次绑定：本轮不追溯，允许并写审计', async () => {
    const early = await planWorld(testDb().db, 'idp-tr-owner-early');
    await rebindToOwner(early);
    const earlyPlan = await early.startedPlan();
    const denied = await transfer(early, earlyPlan, { toUserId: early.outsider.userId });
    expect(await errorOf(denied)).toMatchObject({ status: 403, reason: 'APPROVAL_ADMIN_SELF' });
    expect(await early.readPlan(earlyPlan.id)).toMatchObject({ revision: earlyPlan.revision });
    expect(await interventionLogs(early, earlyPlan.id)).toEqual([]);

    const late = await planWorld(testDb().db, 'idp-tr-owner-late');
    const latePlan = await late.startedPlan();
    await rebindToOwner(late);
    const allowed = await transfer(late, latePlan, { toUserId: late.outsider.userId, reason: '冻结后才绑定' });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    expect(await interventionLogs(late, latePlan.id)).toEqual([
      expect.objectContaining({ after: expect.objectContaining({ intervention: 'transfer' }) }),
    ]);
  });

  it('转交目标是冻结主体（计划员工）：节点开启 avoidSubjects 时被拒（409 APPROVAL_SELF_REVIEW），待办不变', async () => {
    const w = await planWorld(testDb().db, 'idp-tr-subject', {
      nodes: { idp_tutor: { actions: { avoidSubjects: true } } },
    });
    const plan = await w.submit(await w.startedPlan(), 1, w.employee.userId);
    const response = await transfer(w, plan, { toUserId: w.employee.userId });
    expect(await errorOf(response)).toMatchObject({ status: 409, reason: 'APPROVAL_SELF_REVIEW' });
    expect(await w.readPlan(plan.id)).toMatchObject({ revision: plan.revision });
    const instance = await w.instanceOf(plan, 1);
    expect(instance.tasks.filter((t) => t.status === 'pending').map((t) => t.assigneeUserId)).toEqual([
      w.manager.userId,
    ]);
    expect(await interventionLogs(w, plan.id)).toEqual([]);
  });

  it('目标是否回避主体只由节点开关（adminAct 既有判定）决定：预置节点未开 avoidSubjects 时可转给计划员工', async () => {
    const { w, plan } = await atApprovePlan('idp-tr-subject-off');
    const response = await transfer(w, plan, { toUserId: w.employee.userId });
    expect(response.status, await response.clone().text()).toBe(200);
  });
});
