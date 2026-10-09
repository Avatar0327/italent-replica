/**
 * F-068（DEC-354）：IDP 流程干预“转交”的目标例外——目标一般须是已绑定员工且在操作人 IDP 范围内（F-066），
 * 例外是该计划“当前登记”的指导人（计划行的 tutor_employee_id）或与计划期间有交集的带教人（带教信息：带教人 = 目标、
 * 被带教人 = 计划员工），这两类即使在范围外也可作为转交目标。纯账号、范围外的其他员工、不存在的账号仍然拒绝，
 * 且三种拒绝的完整错误响应一致（不造成存在性探测）。例外只放开“范围”这一道，其余判定交给 adminAct，不变。
 * 例外依赖的来源字段（计划的指导人、带教信息的带教人 / 被带教人 / 起止）操作人看不到时视同不是（DEC-309，E3）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator, type OperatorOptions } from './AC-IDP-permission-support.js';
import { addMember } from './AC-PRM-support.js';
import { errorOf, permissionWorldOf, planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';

/** 范围内的计划（员工乙在研发部）；指导人、带教人候选与其他员工都在范围外部门。 */
async function scene(
  label: string,
  planExtra: (far: { employeeId: string }) => Record<string, unknown> = () => ({}),
  options: { start?: boolean } = {},
) {
  const w = await planWorld(testDb().db, label);
  const pw = await permissionWorldOf(w);
  const farOrg = await w.org('范围外部门');
  const far = await w.person('范围外甲', farOrg);
  const stranger = await w.person('范围外乙', farOrg);
  const crew = await w.person('范围外带教人', farOrg);
  const plain = await addMember(pw, 'plain-account');
  const created = await w.createPlan(planExtra(far));
  const plan = options.start === false ? created : await w.start(created);
  return { w, pw, far, stranger, crew, plain, plan };
}

type Scene = Awaited<ReturnType<typeof scene>>;

/** 范围只含研发部的 IDP 操作人对计划发起转交（每次读最新 revision）。 */
type Operator = Awaited<ReturnType<typeof idpOperator>>;

async function transferWith(s: Scene, operator: Operator, body: Record<string, unknown>) {
  const current = await s.w.readPlan(s.plan.id);
  return operator.request('POST', `/plans/${s.plan.id}/transfer`, { ifMatch: current.revision, body });
}

const transferBy = (s: Scene, operator: Operator, toUserId: string, reason?: string) =>
  transferWith(s, operator, { toUserId, ...(reason ? { reason } : {}) });

const operatorOf = (s: Scene, options: OperatorOptions = {}) => idpOperator(s.pw, { orgId: s.w.dept, ...options });

/** 完整错误响应：状态码 + 响应体 + 除时间 / 请求标识外的响应头。 */
async function fullResponse(response: Response) {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (!['date', 'x-request-id', 'x-trace-id', 'etag'].includes(name)) headers[name] = value;
  });
  return { status: response.status, headers, body: await response.text() };
}

const pendingAssignees = async (w: PlanWorld, plan: { id: string }) =>
  (await w.instanceOf(await w.readPlan(plan.id), 1)).tasks
    .filter((t) => t.status === 'pending')
    .map((t) => t.assigneeUserId);

const tutorshipBody = (s: Scene, tutorEmployeeId: string, extra: Record<string, unknown> = {}) => ({
  tutorEmployeeId,
  tuteeEmployeeId: s.w.employee.employeeId,
  startDate: '2026-03-01',
  endDate: null,
  ...extra,
});

async function addTutorship(s: Scene, body: Record<string, unknown>) {
  return s.w.ok<{ id: string; revision: number }>(
    await s.w.http(s.w.hrUser, 'POST', `${IDP}/tutorships`, { ifMatch: 0, body }),
    201,
  );
}

/** 计划上的干预审计（与 AC-IDP-transfer 同口径）。 */
async function interventionLogs(w: PlanWorld, planId: string) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT actor_user_id, after FROM audit_events
      WHERE tenant_id = ${w.tenant.id} AND object_id = ${planId} AND after->>'intervention' IS NOT NULL
      ORDER BY occurred_at, id`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      actor_user_id: string;
      after: Record<string, unknown>;
    }[];
  });
}

/** 审批侧的转交审计（新审批人、原因，DEC-063）。 */
async function approvalTransferLogs(w: PlanWorld, instanceId: string) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT after FROM audit_events WHERE tenant_id = ${w.tenant.id}
      AND object_id = ${instanceId} AND action = 'approval.admin.transfer'`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      after: { assigneeUserId?: string; reason?: string | null };
    }[];
  });
}

/** 成功转交后两侧审计各一条：计划审计（操作人、动作、原因）与审批审计（新审批人、原因）。 */
async function expectTransferAudits(s: Scene, operatorUser: string, toUserId: string, reason: string) {
  expect(await interventionLogs(s.w, s.plan.id)).toEqual([
    expect.objectContaining({
      actor_user_id: operatorUser,
      after: expect.objectContaining({ intervention: 'transfer', reason }),
    }),
  ]);
  const instance = await s.w.instanceOf(await s.w.readPlan(s.plan.id), 1);
  expect(await approvalTransferLogs(s.w, instance.id)).toEqual([
    expect.objectContaining({ after: expect.objectContaining({ assigneeUserId: toUserId, reason }) }),
  ]);
}

describe('AC-IDP（补）F-068 转交目标例外：计划的指导人（DEC-354）', () => {
  it('范围外的计划指导人可以作为转交目标：待办转给他，计划 revision +1，审计各一条', async () => {
    const s = await scene('idp-mn-tutor', (far) => ({ tutorRole: 'other', tutorEmployeeId: far.employeeId }));
    const hr = await operatorOf(s);
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);

    const response = await transferBy(s, hr, s.far.userId, '指导人例外');
    expect(response.status, await response.clone().text()).toBe(200);

    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.far.userId]);
    expect((await s.w.readPlan(s.plan.id)).revision).toBe(s.plan.revision + 1);
    await expectTransferAudits(s, hr.as.user, s.far.userId, '指导人例外');
  });

  it('指导人被改掉（计划当前登记不再是他）后不再享有例外：404，待办与 revision 不变', async () => {
    const s = await scene('idp-mn-retutor', (far) => ({ tutorRole: 'other', tutorEmployeeId: far.employeeId }));
    const hr = await operatorOf(s);
    const patched = await s.w.ok<PlanView>(
      await s.w.http(s.w.hrUser, 'PATCH', `${IDP}/plans/${s.plan.id}`, {
        ifMatch: s.plan.revision,
        body: { tutorRole: 'direct_manager' },
      }),
    );
    expect(patched.tutorEmployeeId).toBe(s.w.manager.employeeId);

    const response = await transferBy(s, hr, s.far.userId);
    expect(await errorOf(response)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await s.w.readPlan(s.plan.id)).toMatchObject({ revision: patched.revision });
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);
  });

  it('只对该计划有效：他是别的计划的指导人不算；在范围内的指导人照常可转（F-066 不变）', async () => {
    const s = await scene('idp-mn-other-plan');
    await s.w.createPlan(
      { name: '另一员工的计划', tutorRole: 'other', tutorEmployeeId: s.far.employeeId },
      s.w.hrUser,
      s.w.outsider,
    );
    const hr = await operatorOf(s);
    expect(await errorOf(await transferBy(s, hr, s.far.userId))).toMatchObject({ status: 404 });
    const inScope = await transferBy(s, hr, s.w.manager.userId);
    expect(inScope.status, await inScope.clone().text()).toBe(200);
  });
});

describe('AC-IDP（补）F-068 转交目标例外：带教人（带教信息，DEC-354）', () => {
  it('范围外、带教期间与计划期间有交集的带教人可以作为转交目标', async () => {
    const s = await scene('idp-mn-tutorship');
    await addTutorship(s, tutorshipBody(s, s.far.employeeId));
    const hr = await operatorOf(s);

    const response = await transferBy(s, hr, s.far.userId, '带教人例外');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.far.userId]);
    await expectTransferAudits(s, hr.as.user, s.far.userId, '带教人例外');
  });

  it('带教记录不算数的四种情形一律 404：期间无交集、方向相反、被带教人不是计划员工、带教记录已删除', async () => {
    const s = await scene('idp-mn-tutorship-neg');
    const hr = await operatorOf(s);
    const later = await addTutorship(s, tutorshipBody(s, s.far.employeeId, { startDate: '2027-01-01', endDate: null }));
    expect(await errorOf(await transferBy(s, hr, s.far.userId))).toMatchObject({ status: 404 }); // 期间无交集
    await addTutorship(s, {
      tutorEmployeeId: s.w.employee.employeeId,
      tuteeEmployeeId: s.far.employeeId,
      startDate: '2026-03-01',
      endDate: null,
    });
    expect(await errorOf(await transferBy(s, hr, s.far.userId))).toMatchObject({ status: 404 }); // 方向相反
    await addTutorship(s, {
      tutorEmployeeId: s.far.employeeId,
      tuteeEmployeeId: s.w.outsider.employeeId,
      startDate: '2026-03-01',
      endDate: null,
    });
    expect(await errorOf(await transferBy(s, hr, s.far.userId))).toMatchObject({ status: 404 }); // 带教的是别人

    const live = await addTutorship(s, tutorshipBody(s, s.far.employeeId));
    expect((await transferBy(s, hr, s.stranger.userId)).status).toBe(404);
    await s.w.ok(await s.w.http(s.w.hrUser, 'DELETE', `${IDP}/tutorships/${live.id}`, { ifMatch: live.revision }));
    await s.w.ok(await s.w.http(s.w.hrUser, 'DELETE', `${IDP}/tutorships/${later.id}`, { ifMatch: later.revision }));
    expect(await errorOf(await transferBy(s, hr, s.far.userId))).toMatchObject({ status: 404 }); // 已删除
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);
    expect(await s.w.readPlan(s.plan.id)).toMatchObject({ revision: s.plan.revision });
  });
});

describe('AC-IDP（补）F-068 转交目标例外：其余目标仍被拒且响应不可区分', () => {
  it('范围外的其他员工、纯账号、不存在的账号、他人计划的指导人、已失效的带教人：完整错误响应完全相同', async () => {
    const s = await scene('idp-mn-uniform');
    const hr = await operatorOf(s);
    await s.w.createPlan(
      { name: '他人计划', tutorRole: 'other', tutorEmployeeId: s.far.employeeId },
      s.w.hrUser,
      s.w.outsider,
    );
    await addTutorship(s, tutorshipBody(s, s.stranger.employeeId, { startDate: '2025-01-01', endDate: '2025-06-30' }));

    const targets = [
      s.stranger.userId, // 范围外且既非指导人也非带教人（带教期间已结束）
      s.plain.id, // 未绑定员工的纯账号
      '00000000-0000-4000-8000-0000000000aa', // 不存在的账号
      s.far.userId, // 只是另一个计划的指导人
    ];
    const responses = [];
    for (const target of targets) responses.push(await fullResponse(await transferBy(s, hr, target)));
    expect(responses[0]!.status).toBe(404);
    for (const response of responses.slice(1)) expect(response).toEqual(responses[0]);

    expect(await s.w.readPlan(s.plan.id)).toMatchObject({ revision: s.plan.revision });
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);
  });
});

/** 会签节点（员工 + 指导人同节点）的世界：计划指导人 = 范围外的甲，开始后员工与指导人各有一条待办。 */
async function countersignScene(label: string) {
  const countersign = {
    key: 'set_goals',
    name: '会签制定目标',
    kind: 'countersign',
    approvers: ['idp_employee', 'idp_tutor'],
    transitionRule: { type: 'all' },
    actions: { avoidSelf: false, reject: false, jump: true, revoke: false },
  };
  const w = await planWorld(testDb().db, label, {
    planNodes: [
      countersign,
      {
        key: 'approve_plan',
        name: '审批发展计划',
        approver: 'idp_tutor',
        actions: { avoidSelf: false, reject: true, rejectToPrevious: true, jump: true, revoke: false },
      },
    ],
  });
  const pw = await permissionWorldOf(w);
  const farOrg = await w.org('范围外部门');
  const far = await w.person('范围外指导人', farOrg);
  const stranger = await w.person('范围外乙', farOrg);
  const plain = await addMember(pw, 'plain-account');
  const plan = await w.startedPlan({ tutorRole: 'other', tutorEmployeeId: far.employeeId });
  const pending = (await w.instanceOf(plan, 1)).tasks.filter((t) => t.status === 'pending');
  const hr = await idpOperator(pw, { orgId: w.dept });
  return { w, plan, far, stranger, plain, pending, hr };
}

describe('AC-IDP（补）F-068 转交目标例外：只放开范围，且失败不暴露带教 / 指导关系（第 2 轮，DEC-354）', () => {
  it('例外只放开范围这一关：目标已是同节点其他在办办理人（会签）仍被拒，且与普通范围外目标同一个 404，待办不变', async () => {
    const c = await countersignScene('idp-mn-countersign');
    const employeeTask = c.pending.find((t) => t.assigneeUserId === c.w.employee.userId)!;
    const attempt = async (toUserId: string) =>
      fullResponse(
        await c.hr.request('POST', `/plans/${c.plan.id}/transfer`, {
          ifMatch: c.plan.revision,
          body: { toUserId, taskId: employeeTask.id },
        }),
      );
    const mentor = await attempt(c.far.userId);
    expect(mentor.status).toBe(404);
    expect(mentor).toEqual(await attempt(c.stranger.userId));
    expect(mentor).toEqual(await attempt(c.plain.id));
    expect(mentor).toEqual(await attempt('00000000-0000-4000-8000-0000000000aa'));
    expect(await c.w.readPlan(c.plan.id)).toMatchObject({ revision: c.plan.revision });
    expect((await c.w.instanceOf(c.plan, 1)).tasks.filter((t) => t.status === 'pending')).toHaveLength(2);
  });

  it('会签有多条待办而未指定 taskId：与目标无关的 400 IDP_TRANSFER_TASK_REQUIRED，指导人与普通目标一样', async () => {
    const c = await countersignScene('idp-mn-task-required');
    const attempt = async (toUserId: string) =>
      fullResponse(
        await c.hr.request('POST', `/plans/${c.plan.id}/transfer`, { ifMatch: c.plan.revision, body: { toUserId } }),
      );
    const mentor = await attempt(c.far.userId);
    expect(mentor.status).toBe(400);
    expect(mentor.body).toContain('IDP_TRANSFER_TASK_REQUIRED');
    expect(mentor).toEqual(await attempt(c.stranger.userId));
    expect(mentor).toEqual(await attempt(c.plain.id));
    expect(mentor).toEqual(await attempt('00000000-0000-4000-8000-0000000000aa'));
  });

  /** 例外目标（计划指导人、带教人）与普通目标（范围外员工、纯账号、不存在账号）逐个换 toUserId，完整响应必须相同。 */
  async function expectIndistinguishable(s: Scene, hr: Operator, body: (toUserId: string) => Record<string, unknown>) {
    const targets = [
      s.far.userId,
      s.crew.userId,
      s.stranger.userId,
      s.plain.id,
      '00000000-0000-4000-8000-0000000000aa',
    ];
    const responses = [];
    for (const target of targets) responses.push(await fullResponse(await transferWith(s, hr, body(target))));
    for (const response of responses.slice(1)) expect(response).toEqual(responses[0]);
    return responses[0]!;
  }

  /** 计划指导人 = 范围外的甲，范围外的带教人 = crew（带教记录与计划期间有交集）。 */
  async function mentorScene(label: string, options: { start?: boolean } = {}) {
    const s = await scene(
      label,
      (far) => ({ tutorRole: 'other', tutorEmployeeId: far.employeeId }),
      options.start === false ? { start: false } : {},
    );
    await addTutorship(s, tutorshipBody(s, s.crew.employeeId));
    return { s, hr: await operatorOf(s) };
  }

  it('taskId 不属于该实例：范围外指导人 / 带教人与普通范围外目标完整响应相同（404），计划与待办不变', async () => {
    const { s, hr } = await mentorScene('idp-mn-bad-task');
    const response = await expectIndistinguishable(s, hr, (toUserId) => ({ toUserId, taskId: randomUUID() }));
    expect(response.status).toBe(404);
    expect(await s.w.readPlan(s.plan.id)).toMatchObject({ revision: s.plan.revision });
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);
  });

  it('待办已关闭（已被转交）：同上，指导人 / 带教人与普通目标完整响应相同', async () => {
    const { s, hr } = await mentorScene('idp-mn-closed-task');
    const closed = (await s.w.instanceOf(s.plan, 1)).tasks.find((t) => t.status === 'pending')!;
    const moved = await transferBy(s, hr, s.w.manager.userId);
    expect(moved.status, await moved.clone().text()).toBe(200);
    const after = await s.w.readPlan(s.plan.id);

    const response = await expectIndistinguishable(s, hr, (toUserId) => ({ toUserId, taskId: closed.id }));
    expect(response.status).toBe(404);
    expect(await s.w.readPlan(s.plan.id)).toMatchObject({ revision: after.revision });
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.manager.userId]);
  });

  it('计划没有运行阶段（未开始）：与目标无关的 409 IDP_NO_RUNNING_STAGE，指导人 / 带教人与普通目标完整响应相同', async () => {
    const { s, hr } = await mentorScene('idp-mn-no-stage', { start: false });
    const response = await expectIndistinguishable(s, hr, (toUserId) => ({ toUserId }));
    expect(response.status).toBe(409);
    expect(response.body).toContain('IDP_NO_RUNNING_STAGE');
    expect(await s.w.readPlan(s.plan.id)).toMatchObject({ status: 'not_started', revision: s.plan.revision });
  });
});

describe('AC-IDP（补）F-068 转交目标例外：来源字段看不到时视同不是（DEC-309）', () => {
  it('看不到计划的指导人字段：指导人例外不生效，与其他范围外目标同一个 404；在范围内的目标不受影响', async () => {
    const s = await scene('idp-mn-hidden-plan', (far) => ({ tutorRole: 'other', tutorEmployeeId: far.employeeId }));
    const hr = await operatorOf(s, { hidden: { plan: ['tutorEmployeeId'] } });
    const denied = await fullResponse(await transferBy(s, hr, s.far.userId));
    expect(denied.status).toBe(404);
    expect(denied).toEqual(await fullResponse(await transferBy(s, hr, s.stranger.userId)));
    const inScope = await transferBy(s, hr, s.w.manager.userId);
    expect(inScope.status, await inScope.clone().text()).toBe(200);
  });

  it('看不到带教信息的带教人 / 被带教人 / 起止字段：带教人例外不生效，404', async () => {
    for (const field of ['tutorEmployeeId', 'tuteeEmployeeId', 'startDate', 'endDate']) {
      const s = await scene(`idp-mn-hidden-${field}`);
      await addTutorship(s, tutorshipBody(s, s.far.employeeId));
      const hr = await operatorOf(s, { hidden: { tutorship: [field] } });
      const response = await transferBy(s, hr, s.far.userId);
      expect(await errorOf(response), field).toMatchObject({ status: 404 });
      expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);
    }
  });
});
