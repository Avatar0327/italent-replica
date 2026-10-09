/**
 * F-067 第 2 轮 / DEC-358①（同 DEC-354）：审批中心通用的 `admin-transfer` / `admin-intervene` 改派 **IDP 审批待办**时，
 * 目标除“已绑定员工且在操作人 IDP 范围内”外，还可以是该计划当前的指导人（计划行 tutor_employee_id）或与计划期间有交集的
 * 带教人（带教信息：带教人 = 目标、被带教人 = 计划员工），即使在范围外。纯账号 / 不存在账号 / 范围外的其他员工仍拒绝，
 * 完整错误响应一致；例外目标在其余判定（版本冲突、流程已结束、待办无效、同节点已是办理人、缺理由）失败时，响应也与
 * 普通范围外拒绝完全相同，不能拿失败响应的差异探测“目标是该计划的指导人 / 带教人”（F-068 #153 审查发现的探测通道）。
 * 来源字段（计划的指导人、带教信息的四个字段）操作人看不到时视同不是（DEC-309 / E3）。
 * 操作人范围与字段可见性用测试替身注入；指导人、带教人用 IDP 的计划 / 带教信息接口建立。
 */
import { IDP_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '@italent/api';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { planWorld, type PlanWorld } from './AC-IDP-plan-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const APV = '/api/tenant/approval';
const IDP = '/api/tenant/idp';
const IDP_PLAN = IDP_OBJECTS.plan.code;
const MISSING_USER = '00000000-0000-4000-8000-0000000000f7';

const personScope = (personIds: readonly string[]): ModuleScope => ({
  ...EMPTY_SCOPE,
  personIds: [...personIds],
  hasDataPermission: true,
  terms: [{ dimension: 'management', orgIds: [], personIds: [...personIds] }],
});

/** 来源字段投影：IDP 各对象的全部字段，可按对象隐藏部分字段。 */
const fieldsOf = (hidden: Readonly<Record<string, readonly string[]>>) => (objectCode: string) => {
  const object = Object.values(IDP_OBJECTS).find((candidate) => candidate.code === objectCode);
  const skip = new Set(hidden[objectCode] ?? []);
  return new Set((object?.fields ?? []).map((field) => field.code).filter((code) => !skip.has(code)));
};

/** 范围只含计划员工的审批管理员（未绑定员工的独立成员）；hidden：按对象编码隐藏的字段。 */
async function scene(
  label: string,
  planExtra: (far: { employeeId: string }) => Record<string, unknown> = () => ({}),
  worldOptions: Parameters<typeof planWorld>[2] = {},
) {
  const w = await planWorld(testDb().db, label, worldOptions);
  const farOrg = await w.org('范围外部门');
  const far = await w.person('范围外甲', farOrg);
  const stranger = await w.person('范围外乙', farOrg);
  const plain = await w.member('未绑定纯账号');
  const admin = await w.member('审批管理员');
  const plan = await w.startedPlan(planExtra(far));
  const instance = await w.instanceOf(plan, 1);
  const taskId = instance.tasks.find((t) => t.status === 'pending' && t.assigneeUserId === w.employee.userId)!.id;

  const operator = (hidden: Readonly<Record<string, readonly string[]>> = {}) => {
    const authorize: Authorizer = () => true;
    const viewable = fieldsOf(hidden);
    registerScopeProvider(authorize, {
      scope: async (query) => (query.objectCode === IDP_PLAN ? personScope([w.employee.employeeId]) : EMPTY_SCOPE),
      authorize: async () => true,
      fields: async (_tenantId, _userId, objectCode) => viewable(objectCode),
    });
    const api = tenantApi(w.db, { authorize, clock: w.clock });
    return (
      path: 'admin-transfer' | 'admin-intervene',
      body: Record<string, unknown>,
      revision = instance.revision,
      user = admin,
    ) =>
      api.request('POST', `${APV}/instances/${instance.id}/${path}`, {
        user,
        tenant: w.tenant.id,
        ifMatch: revision,
        body: path === 'admin-intervene' ? { kind: 'reassign', ...body } : body,
      });
  };
  return { w, far, stranger, plain, admin, plan, instance, taskId, operator };
}

type Scene = Awaited<ReturnType<typeof scene>>;

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

const tutorship = async (w: PlanWorld, tutorEmployeeId: string, tuteeEmployeeId = w.employee.employeeId) =>
  w.ok<{ id: string; revision: number }>(
    await w.http(w.hrUser, 'POST', `${IDP}/tutorships`, {
      ifMatch: 0,
      body: { tutorEmployeeId, tuteeEmployeeId, startDate: '2026-03-01', endDate: null },
    }),
    201,
  );

const PATHS = ['admin-transfer', 'admin-intervene'] as const;
const mentorOf = (far: { employeeId: string }) => ({ tutorRole: 'other', tutorEmployeeId: far.employeeId });
const body = (s: Scene, toUserId: string, extra: Record<string, unknown> = {}) => ({
  taskId: s.taskId,
  toUserId,
  reason: '改派',
  ...extra,
});

describe('AC-APV（补）F-067 / DEC-358① 审批中心 IDP 转交 / 改派：范围外的计划指导人、带教人可作为目标', () => {
  it('范围外的计划指导人：转交与改派都成功，待办落到他', async () => {
    for (const path of PATHS) {
      const s = await scene(`f067-mn-tutor-${path}`, mentorOf);
      expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);
      const response = await s.operator()(path, body(s, s.far.userId));
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
      expect(await pendingAssignees(s.w, s.plan)).toEqual([s.far.userId]);
    }
  });

  it('范围外、带教期间与计划期间有交集的带教人：转交与改派都成功', async () => {
    for (const path of PATHS) {
      const s = await scene(`f067-mn-tutorship-${path}`);
      await tutorship(s.w, s.far.employeeId);
      const response = await s.operator()(path, body(s, s.far.userId));
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
      expect(await pendingAssignees(s.w, s.plan)).toEqual([s.far.userId]);
    }
  });

  it('指导人只对该计划有效：他是别的计划的指导人 / 带教的是别人，仍按范围外 404', async () => {
    const s = await scene('f067-mn-other-plan');
    await s.w.createPlan({ name: '另一员工的计划', ...mentorOf(s.far) }, s.w.hrUser, s.w.outsider);
    await tutorship(s.w, s.far.employeeId, s.w.outsider.employeeId);
    const response = await s.operator()('admin-transfer', body(s, s.far.userId));
    expect(response.status).toBe(404);
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);
  });

  it('范围外其他员工 / 纯账号 / 不存在账号 / 他人计划的指导人：完整响应与彼此相同，待办不变', async () => {
    const s = await scene('f067-mn-uniform');
    await s.w.createPlan({ name: '他人计划', ...mentorOf(s.far) }, s.w.hrUser, s.w.outsider);
    for (const path of PATHS) {
      const responses = [];
      for (const target of [s.stranger.userId, s.plain, MISSING_USER, s.far.userId]) {
        responses.push(await fullResponse(await s.operator()(path, body(s, target))));
      }
      expect(responses[0]!.status, path).toBe(404);
      for (const response of responses.slice(1)) expect(response, path).toEqual(responses[0]);
    }
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);
  });
});

describe('AC-APV（补）F-067 / DEC-358① 例外目标的失败响应与普通范围外拒绝完全相同', () => {
  /** 同一状态下对“例外目标（范围外指导人）”和“普通范围外员工”各发一次，完整响应须相同且是 404。 */
  async function expectSameAsOrdinary(
    s: Scene,
    path: (typeof PATHS)[number],
    overrides: { taskId?: string; revision?: number; reason?: string | null } = {},
  ) {
    const send = (toUserId: string) => {
      const payload = body(s, toUserId, overrides.taskId ? { taskId: overrides.taskId } : {});
      const { reason: _reason, ...withoutReason } = payload;
      return s.operator()(
        path,
        overrides.reason === null ? withoutReason : payload,
        overrides.revision ?? s.instance.revision,
      );
    };
    const ordinary = await fullResponse(await send(s.stranger.userId));
    const exception = await fullResponse(await send(s.far.userId));
    expect(ordinary.status, `${path} 普通拒绝`).toBe(404);
    expect(exception, `${path} 例外目标的失败响应须同普通拒绝`).toEqual(ordinary);
  }

  it('版本冲突、待办无效、改派缺理由：与普通拒绝相同；实例与待办不变', async () => {
    const s = await scene('f067-mn-fail-basic', mentorOf);
    for (const path of PATHS) {
      await expectSameAsOrdinary(s, path, { revision: s.instance.revision + 5 });
      await expectSameAsOrdinary(s, path, { taskId: '00000000-0000-4000-8000-0000000000b1' });
    }
    await expectSameAsOrdinary(s, 'admin-intervene', { reason: null });
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);
    expect((await s.w.instanceOf(s.plan, 1)).revision).toBe(s.instance.revision);
  });

  it('例外目标已是同节点的其他在办办理人（会签，adminAct 的重复办理人判定）：与普通拒绝相同', async () => {
    const countersign = {
      key: 'set_goals',
      name: '会签制定目标',
      kind: 'countersign',
      approvers: ['idp_employee', 'idp_tutor'],
      transitionRule: { type: 'all' },
      actions: { avoidSelf: false, reject: false, jump: true, revoke: false },
    };
    const approve = {
      key: 'approve_plan',
      name: '审批发展计划',
      approver: 'idp_tutor',
      actions: { avoidSelf: false, reject: true, rejectToPrevious: true, jump: true, revoke: false },
    };
    const s = await scene('f067-mn-fail-assignee', mentorOf, { planNodes: [countersign, approve] });
    // 指导人（= 例外目标）与员工同在会签节点办理：把员工的待办转给指导人，被判重复办理人
    const pending = s.instance.tasks.filter((t) => t.status === 'pending');
    expect(pending.map((t) => t.assigneeUserId).sort()).toEqual([s.far.userId, s.w.employee.userId].sort());
    for (const path of PATHS) await expectSameAsOrdinary(s, path);
    expect(await s.w.readPlan(s.plan.id)).toMatchObject({ revision: s.plan.revision });
  });

  it('流程已结束（计划被终止，无运行阶段）：与普通拒绝相同', async () => {
    const s = await scene('f067-mn-fail-closed', mentorOf);
    await s.w.ok(
      await s.w.intervene('terminate', { items: [{ id: s.plan.id, revision: s.plan.revision }], reason: '作废' }),
    );
    const view = await s.w.instanceOf(await s.w.readPlan(s.plan.id), 1);
    for (const path of PATHS) {
      await expectSameAsOrdinary({ ...s, instance: view } as Scene, path, { revision: view.revision });
    }
  });
});

describe('AC-APV（补）F-067 / DEC-358① 来源字段看不到时视同不是（DEC-309）', () => {
  it('看不到计划的指导人字段：指导人例外不生效，与其他范围外目标同一个 404', async () => {
    const s = await scene('f067-mn-hidden-plan', mentorOf);
    const operator = s.operator({ [IDP_PLAN]: ['tutorEmployeeId'] });
    const denied = await fullResponse(await operator('admin-transfer', body(s, s.far.userId)));
    expect(denied.status).toBe(404);
    expect(denied).toEqual(await fullResponse(await operator('admin-transfer', body(s, s.stranger.userId))));
    expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);
  });

  it('看不到带教信息的带教人 / 被带教人 / 起止字段：带教人例外不生效，404', async () => {
    for (const field of ['tutorEmployeeId', 'tuteeEmployeeId', 'startDate', 'endDate']) {
      const s = await scene(`f067-mn-hidden-${field}`);
      await tutorship(s.w, s.far.employeeId);
      const operator = s.operator({ [IDP_OBJECTS.tutorship.code]: [field] });
      const response = await operator('admin-transfer', body(s, s.far.userId));
      expect(response.status, field).toBe(404);
      expect(await pendingAssignees(s.w, s.plan)).toEqual([s.w.employee.userId]);
    }
  });
});
