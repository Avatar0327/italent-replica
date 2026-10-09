/**
 * F-068（DEC-354）：IDP 流程干预“转交”的目标例外——目标一般须是已绑定员工且在操作人 IDP 范围内（F-066），
 * 例外是该计划“当前登记”的指导人（计划行的 tutor_employee_id）或与计划期间有交集的带教人（带教信息：带教人 = 目标、
 * 被带教人 = 计划员工），这两类即使在范围外也可作为转交目标。纯账号、范围外的其他员工、不存在的账号仍然拒绝，
 * 且三种拒绝的完整错误响应一致（不造成存在性探测）。例外只放开“范围”这一道，其余判定交给 adminAct，不变。
 * 例外依赖的来源字段（计划的指导人、带教信息的带教人 / 被带教人 / 起止）操作人看不到时视同不是（DEC-309，E3）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator, type OperatorOptions } from './AC-IDP-permission-support.js';
import { addMember } from './AC-PRM-support.js';
import { errorOf, permissionWorldOf, planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';

/** 范围内的计划（员工乙在研发部）；指导人、带教人候选与其他员工都在范围外部门。 */
async function scene(label: string, planExtra: (far: { employeeId: string }) => Record<string, unknown> = () => ({})) {
  const w = await planWorld(testDb().db, label);
  const pw = await permissionWorldOf(w);
  const farOrg = await w.org('范围外部门');
  const far = await w.person('范围外甲', farOrg);
  const stranger = await w.person('范围外乙', farOrg);
  const plain = await addMember(pw, 'plain-account');
  const plan = await w.startedPlan(planExtra(far));
  return { w, pw, far, stranger, plain, plan };
}

type Scene = Awaited<ReturnType<typeof scene>>;

/** 范围只含研发部的 IDP 操作人对计划发起转交（每次读最新 revision）。 */
async function transferBy(s: Scene, operator: Awaited<ReturnType<typeof idpOperator>>, toUserId: string) {
  const current = await s.w.readPlan(s.plan.id);
  return operator.request('POST', `/plans/${s.plan.id}/transfer`, { ifMatch: current.revision, body: { toUserId } });
}

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

describe('AC-IDP（补）F-068 转交目标例外：计划的指导人（DEC-354）', () => {
  it('范围外的计划指导人可以作为转交目标：待办转给他，计划 revision +1，审计各一条', async () => {
    const s = await scene('idp-mn-tutor', (far) => ({ tutorRole: 'other', tutorEmployeeId: far.employeeId }));
    const hr = await operatorOf(s);
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);

    const response = await transferBy(s, hr, s.far.userId);
    expect(response.status, await response.clone().text()).toBe(200);

    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.far.userId]);
    expect((await s.w.readPlan(s.plan.id)).revision).toBe(s.plan.revision + 1);
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

    const response = await transferBy(s, hr, s.far.userId);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.far.userId]);
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

  it('例外只放开范围这一关：目标已是同节点其他在办办理人（会签）仍被 adminAct 拒绝，待办不变', async () => {
    const countersign = {
      key: 'set_goals',
      name: '会签制定目标',
      kind: 'countersign',
      approvers: ['idp_employee', 'idp_tutor'],
      transitionRule: { type: 'all' },
      actions: { avoidSelf: false, reject: false, jump: true, revoke: false },
    };
    const w = await planWorld(testDb().db, 'idp-mn-countersign', {
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
    const far = await w.person('范围外指导人', await w.org('范围外部门'));
    const plan = await w.startedPlan({ tutorRole: 'other', tutorEmployeeId: far.employeeId });
    const pending = (await w.instanceOf(plan, 1)).tasks.filter((t) => t.status === 'pending');
    const employeeTask = pending.find((t) => t.assigneeUserId === w.employee.userId)!;
    const hr = await idpOperator(pw, { orgId: w.dept });

    const response = await hr.request('POST', `/plans/${plan.id}/transfer`, {
      ifMatch: plan.revision,
      body: { toUserId: far.userId, taskId: employeeTask.id },
    });
    expect(await errorOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_ALREADY_NODE_ASSIGNEE' });
    expect(await w.readPlan(plan.id)).toMatchObject({ revision: plan.revision });
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
