/**
 * R3-T07 PR-B 发展计划执行夹具（docs/02_业务建模/28 §2.3；DEC-296④⑤ / DEC-307 / DEC-309；PR 描述矩阵与入口清单）。
 * 在审批中心夹具（approvalWorld：租户、HR、组织、人员与账号绑定、可调时钟）之上，建 IDP 三类审批流程（员工本人 →
 * 指导人，K-09）、三段发展计划流程、带节点按钮的模板，再建计划、开始、按待办办理。缺省授权器为“全部允许”，
 * 权限用例另用真实授权器（AC-IDP-plan-visibility）。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { approvalWorld, type InstanceView, type Person } from './AC-APV-support.js';
import type { ProcessView, TemplateView } from './AC-IDP-support.js';
import { createProfile, grant, makeGrantable, type PermissionWorld, setObjectPermission } from './AC-PRM-support.js';
import { cmd, type RequestOptions, tenantApi } from './support/tenant-api.js';

export const IDP = '/api/tenant/idp';
const APV = '/api/tenant/approval';

/** 计划开始在 2026-03-01（上海时区中午）；计划期 2026 全年。 */
export const PLAN_NOW = '2026-03-01T04:00:00.000Z';

export interface PlanStageView {
  readonly id: string;
  readonly subProcessId: string;
  readonly seq: number;
  readonly name: string;
  readonly status: 'pending' | 'running' | 'ended' | 'failed';
  readonly approvalInstanceId: string | null;
  readonly dueDate: string | null;
  readonly endedOn: string | null;
  readonly failureReason: string | null;
  readonly attemptCount: number;
}

export interface PlanTaskView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
}

export interface PlanGoalView {
  readonly id: string;
  readonly moduleId: string;
  readonly name: string;
  readonly measure: string | null;
  readonly suggestion: string | null;
  readonly sourceType: 'custom' | 'library' | 'common';
  readonly commonGoalId: string | null;
  readonly indicatorId: string | null;
  readonly indicatorName: string | null;
  readonly indicatorDefinition: string | null;
  readonly indicatorCategory: string | null;
  readonly tasks: PlanTaskView[];
  readonly reviews: { stageId: string; progress: number | null; outcome: string | null }[];
}

export interface PlanView {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly employeeId: string;
  readonly templateId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly tutorRole?: string;
  readonly tutorEmployeeId?: string | null;
  readonly status: 'not_started' | 'running' | 'ended' | 'terminated';
  readonly currentStageName: string | null;
  readonly currentNodeName?: string | null;
  readonly stages: PlanStageView[];
  readonly modules?: { id: string; moduleType: string; name: string; buttons?: string[] }[];
  readonly goals?: PlanGoalView[];
  readonly analyses?: { moduleId: string; currentAnalysis: string | null; developmentItems: string | null }[];
  readonly reviews?: { moduleId: string; stageId: string; summary: string | null; improvement: string | null }[];
  readonly keyInfo?: {
    tutorships?: Record<string, unknown>[];
    careers?: Record<string, unknown>[];
    workShifts?: Record<string, unknown>[];
  };
}

export interface Receipt {
  readonly id: string;
  readonly status: number;
  readonly outcome?: 'opened' | 'skipped' | 'failed' | 'urged' | 'terminated';
  readonly code?: string;
}

type NodeExpr = 'idp_employee' | 'idp_tutor' | 'owner';

/** IDP 审批流程：每个节点 = [key, 名称, 审批人表达式]。 */
function approvalBody(approvalType: string, nodes: readonly (readonly [string, string, NodeExpr])[], admin: string) {
  return {
    code: `IDP_${randomUUID().slice(0, 8)}`,
    name: `IDP ${approvalType}`,
    approvalType,
    priority: 0,
    isFallback: true,
    exceptionAdminUserId: admin,
    conditions: { items: [] },
    nodes: nodes.map(([key, name, approver]) => ({ key, name, approver })),
  };
}

export interface PlanWorldOptions {
  /** 发展目标模块开启无目标校验（AC-IDP-05）。 */
  readonly checkNoneGoal?: boolean;
  /** 发展计划流程的三段（缺省：制定计划自动无规则 → 中期回顾手动 → 期末回顾上一阶段结束后 7 天）。 */
  readonly stages?: (approvals: Approvals) => Record<string, unknown>[];
}

export interface Approvals {
  readonly plan: string;
  readonly mid: string;
  readonly final: string;
}

export async function planWorld(db: Db, label: string, options: PlanWorldOptions = {}) {
  const w = await approvalWorld(db, label);
  w.setNow(PLAN_NOW);
  const hr = w.hr.id;
  const dept = await w.org(`${label}研发部`);
  const manager = await w.person('经理甲', dept);
  const employee = await w.person('员工乙', dept, { directManagerId: manager.employeeId });
  const outsider = await w.person('无关员工丙', dept);

  const http = (user: string, method: string, path: string, options: RequestOptions = {}) =>
    w.request(user, method, path, options);
  /**
   * 真实授权器：员工、指导人没有 IDP 身份，只按参与关系看到计划（缺省夹具的“全部允许”会把每个成员都当成看全部的
   * HR，无关员工的 404 只能在这里断言）。
   */
  const real = tenantApi(db, { authorize: undefined, clock: w.clock });
  const realHttp = (user: string, method: string, path: string, options: RequestOptions = {}) =>
    real.request(method, path, { ...options, ...w.as(user) });
  async function ok<T>(response: Response, status = 200): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }

  async function approvalProcess(type: string, nodes: readonly (readonly [string, string, NodeExpr])[]) {
    const created = await ok<{ id: string; revision: number }>(
      await http(hr, 'POST', `${APV}/processes`, { ifMatch: 0, body: approvalBody(type, nodes, w.exceptionAdmin) }),
      201,
    );
    await ok(await http(hr, 'POST', `${APV}/processes/${created.id}/publish`, { ifMatch: created.revision }));
    return created.id;
  }

  const approvals: Approvals = {
    plan: await approvalProcess('idp_plan', [
      ['set_goals', '制定发展目标', 'idp_employee'],
      ['approve_plan', '审批发展计划', 'idp_tutor'],
    ]),
    mid: await approvalProcess('idp_mid_review', [
      ['employee_mid', '员工中期回顾', 'idp_employee'],
      ['tutor_mid', '指导人中期回顾', 'idp_tutor'],
    ]),
    final: await approvalProcess('idp_final_review', [
      ['employee_final', '员工期末回顾', 'idp_employee'],
      ['tutor_final', '指导人期末回顾', 'idp_tutor'],
    ]),
  };

  const defaultStages = (a: Approvals) => [
    { name: '制定计划', category: 'plan', approvalType: 'idp_plan', approvalProcessId: a.plan, startMode: 'auto' },
    {
      name: '中期回顾',
      category: 'review',
      approvalType: 'idp_mid_review',
      approvalProcessId: a.mid,
      startMode: 'manual',
    },
    {
      name: '期末回顾',
      category: 'evaluation',
      approvalType: 'idp_final_review',
      approvalProcessId: a.final,
      startMode: 'auto',
      startTimeType: 'relative',
      referencePoint: 'previous_end',
      startFrom: 'after',
      days: 7,
    },
  ];
  const process = await ok<ProcessView>(
    await http(hr, 'POST', `${IDP}/processes`, {
      ifMatch: 0,
      body: { name: `${label}发展流程`, orgId: dept, subProcesses: (options.stages ?? defaultStages)(approvals) },
    }),
    201,
  );
  const stageId = (seq: number) => process.subProcesses[seq - 1]!.id;

  let template = await ok<TemplateView>(
    await http(hr, 'POST', `${IDP}/templates`, {
      ifMatch: 0,
      body: { name: `${label}模板${randomUUID().slice(0, 6)}`, orgId: dept, processId: process.id },
    }),
    201,
  );
  const addModule = async (body: Record<string, unknown>) => {
    template = await ok<TemplateView>(
      await http(hr, 'POST', `${IDP}/templates/${template.id}/modules`, { ifMatch: template.revision, body }),
      201,
    );
    return template.modules.at(-1)!;
  };
  const goalButtons = ['RowAddIdpGoal', 'RowEditIdpGoal', 'RowDeleteIdpGoal'];
  const goalModule = await addModule({
    moduleType: 'goal',
    name: '发展目标',
    allowCustomGoal: true,
    allowLibraryGoal: true,
    competencySource: 'current_position',
    goalReviewEnabled: true,
    taskEnabled: true,
    checkNoneGoal: options.checkNoneGoal ?? false,
    nodeSettings: [
      { subProcessId: stageId(1), nodeKey: 'set_goals', enabled: true, buttons: goalButtons },
      { subProcessId: stageId(1), nodeKey: 'approve_plan', enabled: true, buttons: ['RowEditIdpGoal'] },
      { subProcessId: stageId(2), nodeKey: 'employee_mid', enabled: true, buttons: ['RowEditIdpGoal'] },
    ],
  });
  const analysisModule = await addModule({
    moduleType: 'analysis',
    name: '个人信息综述',
    nodeSettings: [{ subProcessId: stageId(1), nodeKey: 'set_goals', enabled: true, buttons: ['EditModuleContent'] }],
  });
  const reviewModule = await addModule({
    moduleType: 'review',
    name: '中期回顾',
    nodeSettings: [
      { subProcessId: stageId(2), nodeKey: 'employee_mid', enabled: true, buttons: ['EditModuleContent'] },
    ],
  });
  const keyInfoModule = await addModule({
    moduleType: 'key_info',
    name: '关键信息',
    keyInfoSources: ['career', 'work_shift', 'tutorship'],
  });
  const commonGoal = async (name: string, extra: Record<string, unknown> = {}) => {
    template = await ok<TemplateView>(
      await http(hr, 'POST', `${IDP}/templates/${template.id}/common-goals`, {
        ifMatch: template.revision,
        body: { moduleId: goalModule.id, name, ...extra },
      }),
      201,
    );
    return template.commonGoals.at(-1)!;
  };
  const firstCommonGoal = await commonGoal('提升跨部门沟通', { measure: '季度 360 评分 ≥ 4', suggestion: '主持周会' });
  const publish = async () => {
    template = await ok<TemplateView>(
      await http(hr, 'POST', `${IDP}/templates/${template.id}/publish`, { ifMatch: template.revision }),
    );
  };
  await publish();

  async function createPlan(extra: Record<string, unknown> = {}, actor = hr, person: Person = employee) {
    return ok<PlanView>(
      await http(actor, 'POST', `${IDP}/plans`, {
        ifMatch: 0,
        body: {
          name: '2026 年度发展计划',
          employeeId: person.employeeId,
          templateId: template.id,
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          tutorRole: 'direct_manager',
          ...extra,
        },
      }),
      201,
    );
  }

  const plan = (id: string, user = hr) => http(user, 'GET', `${IDP}/plans/${id}`);
  const readPlan = async (id: string, user = hr) => ok<PlanView>(await plan(id, user));

  async function start(view: PlanView, actor = hr) {
    return ok<PlanView>(await http(actor, 'POST', `${IDP}/plans/${view.id}/start`, { ifMatch: view.revision }));
  }

  async function startedPlan(extra: Record<string, unknown> = {}) {
    return start(await createPlan(extra));
  }

  async function instanceOf(view: PlanView, seq: number): Promise<InstanceView> {
    const stage = view.stages.find((s) => s.seq === seq)!;
    expect(stage.approvalInstanceId, JSON.stringify(stage)).toBeTruthy();
    return w.detail(stage.approvalInstanceId!, hr);
  }

  /** 当前阶段某人的在办任务。 */
  async function pendingTask(view: PlanView, seq: number, user: string) {
    const instance = await instanceOf(view, seq);
    const task = instance.tasks.find((t) => t.status === 'pending' && t.assigneeUserId === user);
    expect(task, JSON.stringify(instance.tasks)).toBeTruthy();
    return { instance, task: task! };
  }

  /** 以待办人身份“同意”（提交）当前节点。 */
  async function submitRaw(view: PlanView, seq: number, user: string) {
    const { instance, task } = await pendingTask(view, seq, user);
    return w.taskAction(user, task.id, 'approve', instance.revision);
  }

  async function submit(view: PlanView, seq: number, user: string) {
    await ok(await submitRaw(view, seq, user));
    return readPlan(view.id);
  }

  /** 执行人写入（If-Match = 计划 revision）。 */
  const execute = async (user: string, method: string, path: string, body?: unknown) => {
    const current = await readPlan(path.split('/')[2]!);
    return http(user, method, `${IDP}${path}`, { ifMatch: current.revision, ...(body === undefined ? {} : { body }) });
  };

  async function addGoal(view: PlanView, user: string, body: Record<string, unknown> = {}) {
    return ok<PlanView>(
      await execute(user, 'POST', `/plans/${view.id}/goals`, {
        moduleId: goalModule.id,
        name: '学习领域建模',
        ...body,
      }),
      201,
    );
  }

  /** 平台调度（凌晨 2 点自动开启）：时钟由进程注入。 */
  async function runScheduler(iso: string) {
    // 动态导入：调度入口随实现提交，失败测试阶段按断言失败而不是整个文件导入失败
    const { runIdpAutoStarts } = await import('../../apps/api/src/modules/idp/scheduler.js');
    return runIdpAutoStarts(db, cmd(), { tenantId: w.tenant.id }, { clock: () => new Date(iso) });
  }

  const intervene = (path: string, body: unknown, actor = hr, ifMatch = 0) =>
    http(actor, 'POST', `${IDP}/plans/${path}`, { ifMatch, body });

  return {
    ...w,
    hrUser: hr,
    dept,
    manager,
    employee,
    outsider,
    approvals,
    process,
    stageId,
    get template() {
      return template;
    },
    goalModule,
    analysisModule,
    reviewModule,
    keyInfoModule,
    firstCommonGoal,
    commonGoal,
    publish,
    http,
    realHttp,
    ok,
    createPlan,
    plan,
    readPlan,
    start,
    startedPlan,
    instanceOf,
    pendingTask,
    submitRaw,
    submit,
    execute,
    addGoal,
    runScheduler,
    intervene,
  };
}

export type PlanWorld = Awaited<ReturnType<typeof planWorld>>;

/** 无关员工丙没有直线经理：给他建计划时显式指定指导人（经理甲）。 */
export const otherTutor = (w: PlanWorld) => ({ tutorRole: 'other', tutorEmployeeId: w.manager.employeeId });

export async function errorOf(response: Response) {
  const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error.code, reason: body.error.details?.reason };
}

/**
 * 真实授权器的权限世界（同一租户）：HR 成为租户管理员以配置身份，IDP 操作人另建（idpOperator）。
 * 业务数据仍由“全部允许”的夹具接口建。
 */
export async function permissionWorldOf(w: PlanWorld): Promise<PermissionWorld> {
  const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hrUser }, cmd());
  return {
    db: w.db,
    tenant: w.tenant,
    admin: w.hr,
    adminRecord,
    api: tenantApi(w.db, { authorize: undefined, clock: w.clock }),
    asAdmin: { user: w.hrUser, tenant: w.tenant.id },
  };
}

/** TenantBase 身份：任职记录与组织全部字段可查看；orgIds 为 TenantBase 数据范围（含下级），空 = 缺省空范围。 */
export async function grantTenantBaseView(pw: PermissionWorld, userId: string, orgIds: readonly string[]) {
  const profile = await createProfile(pw, `tb-${userId.slice(0, 6)}`, { apps: ['TenantBase'] });
  for (const definition of [MODULE_OBJECTS.employmentRecord, MODULE_OBJECTS.organization]) {
    const response = await setObjectPermission(
      pw,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
        buttons: [],
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(pw, [profile.id]);
  expect((await grant(pw, userId, profile.id)).status).toBe(201);
  if (!orgIds.length) return;
  const scope = await pw.api.request('PUT', `/api/tenant/permission/scopes/${userId}/TenantBase`, {
    ...pw.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: orgIds.map((orgId) => ({ orgId, includeDescendants: true })) },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
}
