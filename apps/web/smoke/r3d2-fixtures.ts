import { IDP_OBJECTS } from '../../../packages/domain/src/idp/catalog.js';
import type { Page, Route } from '@playwright/test';
import { employee, snapshotFixture, user } from './fixtures.js';

// 全部为合成数据（AGENTS.md §5）；ID 不截断随机 UUID，固定写死便于断言。
export const planId = 'b0000000-0000-4000-8000-000000000001';
export const waitingId = 'b0000000-0000-4000-8000-000000000002';
export const templateId = 'b0000000-0000-4000-8000-000000000003';
export const processId = 'b0000000-0000-4000-8000-000000000004';
export const orgId = 'b0000000-0000-4000-8000-000000000005';
const moduleId = 'b0000000-0000-4000-8000-000000000006';
const subProcessId = 'b0000000-0000-4000-8000-000000000007';
export const goalModuleId = 'b0000000-0000-4000-8000-000000000008';
const analysisModuleId = 'b0000000-0000-4000-8000-000000000009';
const reviewModuleId = 'b0000000-0000-4000-8000-00000000000a';
const approvalId = 'b0000000-0000-4000-8000-00000000000b';
export const goalId = 'b0000000-0000-4000-8000-000000000201';
export const taskId = 'b0000000-0000-4000-8000-000000000202';
export const otherPlanId = 'b0000000-0000-4000-8000-000000000011';
export const otherEmployee = '30000000-0000-4000-8000-000000000002';
export const thirdEmployee = '30000000-0000-4000-8000-000000000003';
export const tutoredId = 'b0000000-0000-4000-8000-000000000012';
/** 模板只有基本信息模块的计划：打开详情 403 IDP_PLAN_NO_VISIBLE_MODULE（F-164）。 */
export const basicOnlyId = 'b0000000-0000-4000-8000-000000000013';

const stage = (seq: number, name: string, status: string) => ({
  id: `b0000000-0000-4000-8000-00000000010${seq}`,
  subProcessId,
  seq,
  name,
  status,
  approvalInstanceId: null as string | null,
  dueDate: '2026-10-01',
  endedOn: null as string | null,
  failureReason: null,
  attemptCount: 0,
});
const stages = [stage(1, '制定计划', 'running'), stage(2, '中期回顾', 'pending')];
/** 列表行：真实列表接口不返回 currentNodeName（plan-routes summaries），夹具与之一致。 */
export const plan = {
  id: planId,
  revision: 3,
  name: '合成发展计划',
  employeeId: employee,
  templateId,
  processId,
  startDate: '2026-10-01',
  endDate: '2026-12-31',
  tutorRole: 'direct_manager',
  tutorEmployeeId: employee,
  status: 'running',
  currentStageName: '制定计划',
  stages,
};
const GOAL_BUTTONS = ['RowAddIdpGoal', 'RowEditIdpGoal', 'RowDeleteIdpGoal'];
/**
 * 目标模块的“制定任务”开关：真实参与人视图不返回（后端缺口），'missing' 模拟该形状；
 * 默认 true 表示缺口补齐后的契约形状，用来覆盖任务写入链路。
 */
type TaskSwitch = boolean | 'missing';
function planDetail(buttons: string[], taskSwitch: TaskSwitch, reviewButtons: string[]) {
  const goalModule = { id: goalModuleId, moduleType: 'goal', name: '发展目标', displayOrder: 1, buttons };
  return {
    ...plan,
    currentNodeName: '制定发展目标',
    modules: [
      { id: moduleId, moduleType: 'basic', name: '基本信息', displayOrder: 0, buttons: [] },
      taskSwitch === 'missing' ? goalModule : { ...goalModule, taskEnabled: taskSwitch },
      { id: analysisModuleId, moduleType: 'analysis', name: '综述', displayOrder: 2, buttons: [] },
      { id: reviewModuleId, moduleType: 'review', name: '中期回顾', displayOrder: 3, buttons: reviewButtons },
    ],
    goals: [
      {
        id: goalId,
        moduleId: goalModuleId,
        name: '合成发展目标',
        measure: '完成合成课程',
        suggestion: null,
        startDate: '2026-10-01',
        endDate: '2026-11-30',
        sourceType: 'custom',
        displayOrder: 0,
        tasks: [{ id: taskId, name: '合成任务', description: '合成任务描述', startDate: '2026-10-02', endDate: null }],
        reviews: [],
      },
    ],
    analyses: [{ moduleId: analysisModuleId, currentAnalysis: '合成现状分析', developmentItems: '合成待发展项' }],
    reviews: [
      { moduleId: reviewModuleId, stageId: stages[0]!.id, summary: '合成阶段总结', improvement: '合成改进方法' },
    ],
    keyInfo: { tutorships: [], careers: [], workShifts: [] },
  };
}
const waiting = { ...plan, id: waitingId, revision: 1, name: '合成未开始计划', status: 'not_started', stages: [] };
/** 我的发展计划接口同时返回本人计划与作为指导人参与的他人计划（plan-routes my-plans）。 */
const participating = {
  ...plan,
  id: otherPlanId,
  name: '合成参与计划',
  employeeId: otherEmployee,
  tutorEmployeeId: undefined,
  tutorRole: undefined,
  processId: undefined,
};
function participantRow(row: typeof plan | typeof participating) {
  const { tutorRole: _r, tutorEmployeeId: _t, processId: _p, ...rest } = row;
  // 三条列表夹具的指导人均为 employee；不改变参与人详情的字段集。
  return { ...rest, tutorEmployeeId: employee, tutorName: '合成员工甲' };
}
/** 我辅导的发展计划（plan-routes tutor-plans）：指导人为本人的进行中计划，返回指导人，不含指导人角色与流程。 */
function tutorRow(id: string, name: string, employeeId: string) {
  const { tutorRole: _r, processId: _p, ...rest } = plan;
  return { ...rest, id, name, employeeId, tutorEmployeeId: employee };
}
export const template = {
  id: templateId,
  revision: 2,
  name: '合成发展计划模板',
  description: '合成说明',
  orgId,
  publicDown: true,
  processId,
  status: 'published',
  referenced: true,
  modules: [
    {
      id: moduleId,
      moduleType: 'goal',
      name: '发展目标',
      description: '合成目标模块说明',
      displayOrder: 0,
      allowCustomGoal: true,
      allowLibraryGoal: false,
      competencySource: 'current_position',
      goalReviewEnabled: true,
      taskEnabled: true,
      checkNoneGoal: false,
      nodeSettings: [{ subProcessId, nodeKey: 'n1', enabled: true, buttons: ['RowAddIdpGoal', 'RowEditIdpGoal'] }],
    },
    {
      id: goalModuleId,
      moduleType: 'key_info',
      name: '关键信息',
      description: null,
      displayOrder: 1,
      keyInfoSources: ['work_shift'],
      keyInfoBlocks: [{ block: 'work_shift', fields: ['orgId', 'startDate'] }],
    },
  ],
  commonGoals: [],
};
export const process = {
  id: processId,
  revision: 1,
  name: '合成发展计划流程',
  orgId,
  publicDown: false,
  enabled: true,
  referenced: false,
  subProcesses: [
    {
      id: subProcessId,
      seq: 1,
      name: '合成制定阶段',
      category: 'plan',
      approvalType: 'idp_plan',
      approvalProcessId: approvalId,
      startMode: 'auto',
      startTimeType: null,
      fixedDate: null,
      referencePoint: null,
      startFrom: null,
      days: null,
    },
  ],
};

const levels: Record<string, string> = {
  create: 'list',
  urge: 'list',
  startNext: 'list',
  terminate: 'list',
  issue: 'list',
};
export interface IdpCall {
  method: string;
  path: string;
  body: unknown;
  key: string | null;
  revision: string | null;
  /** 写入成功后服务端保存的流程记录（仅 processVersions 模式），代表“库里”的结果。 */
  stored?: Record<string, unknown>;
}
export interface IdpMockOptions {
  hasDataPermission?: boolean;
  /** 按对象覆盖可见 / 可编辑字段，模拟服务端字段裁剪；列表行同步去掉不可见字段。 */
  fields?: Record<string, { viewable?: string[]; editable?: string[] }>;
  /** 计划详情里目标模块的节点按钮（参与人视图）；HR 视图传空数组。 */
  goalButtons?: string[];
  /** 目标模块“制定任务”开关，见 TaskSwitch。 */
  taskSwitch?: TaskSwitch;
  /** 按对象覆盖数据操作权（服务端 dataOperations：create / update / delete，默认全部为 true）。 */
  operations?: Record<string, Record<string, boolean>>;
  /** 写接口的响应状态（如 500 模拟结果未知、409 模拟版本冲突）。 */
  writeStatus?: number;
  /** 覆盖流程夹具里子流程的字段值（如改成相对时间开启），再按字段权限裁剪。 */
  subProcess?: Record<string, unknown>;
  /** 发生过写请求后，详情读取不再返回 revision（模拟冲突后重读得到无效回执）。 */
  rereadWithoutRevision?: boolean;
  /** 前几次写请求返回 409，之后正常写入。 */
  conflictTimes?: number;
  /**
   * 每次写请求返回 409 时，流程先被别人改成下一个版本（依次取用），之后的详情重读返回该版本；
   * 写入成功时把请求体合并进当前版本，模拟库里的记录。
   */
  processVersions?: Record<string, unknown>[];
  /** 发生过写请求后，流程详情里每个子流程去掉这些键（模拟冲突后重读到被裁剪的子流程）。 */
  rereadSubProcessOmit?: string[];
  /** 计划详情里回顾模块的节点按钮（参与人视图，F-155b）；默认不给。 */
  reviewButtons?: string[];
  /** 回顾保存成功（库里已进版本）但回执异常：缺 revision，或 revision 仍是请求带的旧版本（F-164 第 1 轮 P2-3）。 */
  reviewReceipt?: 'without-revision' | 'stale-revision';
  /** 第一阶段被 HR 跳过（已终止，F-155），第二阶段进行中。 */
  skippedFirstStage?: boolean;
  /**
   * 运行中阶段带审批实例（回顾“提交”= 同意本人待办，F-164 第 1 轮 P2-4）；审批接口照 approval routes 夹具。
   * mine：本人有在办待办；others：在办待办是别人的，本人没有动作（详情 actions 为空）。
   */
  reviewApproval?: 'mine' | 'others';
  /** 同意成功（实例已前进）但回执的 revision 仍是请求带的版本：按结果未知锁定。 */
  approveReceipt?: 'stale-revision';
}

export const reviewInstanceId = 'c0000000-0000-4000-8000-000000000201';
export const reviewTaskId = 'c0000000-0000-4000-8000-000000000202';
/** 与 GET /approval/instances/:id 同形；同意成功时返回动作后的详情（routes.ts respondOutcome → respondDetail）。 */
const otherUser = 'c0000000-0000-4000-8000-000000000299';
function reviewApprovalDetail(revision: number, done: boolean, assignee = user) {
  return {
    id: reviewInstanceId,
    title: '合成员工甲的发展计划',
    revision,
    status: done ? 'approved' : 'running',
    approvalType: 'idp_plan',
    actions: done || assignee !== user ? [] : ['approve'],
    recordsHidden: false,
    form: { values: {} },
    tasks: [
      { id: reviewTaskId, nodeName: '员工制定计划', status: done ? 'approved' : 'pending', assigneeUserId: assignee },
    ],
    logs: [],
  };
}

/** 照 stage-service endRunningStage：被跳过的阶段记已终止和结束日期，作废的审批实例 id 保留。 */
const skippedStages = [
  {
    ...stage(1, '制定计划', 'terminated'),
    approvalInstanceId: 'c0000000-0000-4000-8000-000000000101',
    endedOn: '2026-10-10',
  },
  stage(2, '中期回顾', 'running'),
];
function detailOf(options: IdpMockOptions) {
  const base = planDetail(options.goalButtons ?? GOAL_BUTTONS, options.taskSwitch ?? true, options.reviewButtons ?? []);
  const skipped = { ...base, stages: skippedStages, currentStageName: '中期回顾' };
  const withApproval = {
    ...base,
    stages: base.stages.map((row) =>
      row.status === 'running' ? { ...row, approvalInstanceId: reviewInstanceId } : row,
    ),
  };
  const chosen = options.skippedFirstStage ? skipped : options.reviewApproval ? withApproval : base;
  return trimDetail(chosen, options);
}

function objectPermission(code: string, options: IdpMockOptions) {
  const object = Object.values(IDP_OBJECTS).find((item) => item.code === code)!;
  const fields = object.fields.map((field) => field.code);
  const override = options.fields?.[code];
  const viewable = override?.viewable ?? fields;
  return {
    objectCode: code,
    dataOperations: options.operations?.[code] ?? { create: true, update: true, delete: true },
    viewableFields: viewable,
    editableFields:
      override?.editable ?? viewable.filter((field) => !object.fields.find((item) => item.code === field)?.system),
    buttons: object.buttons.map((button) => ({ buttonCode: button.code, level: levels[button.code] ?? 'detail' })),
  };
}
/** 服务端按字段权限裁剪：对象目录里有、但不可见的键不输出。 */
function trim<T extends object>(code: string, row: T, options: IdpMockOptions): T {
  const viewable = options.fields?.[code]?.viewable;
  if (!viewable) return row;
  const known = Object.values(IDP_OBJECTS)
    .find((item) => item.code === code)!
    .fields.map((field) => field.code);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !known.includes(key) || viewable.includes(key))) as T;
}

/** 父字段不可见时，服务端 presenter 整个省略嵌套数组（plan-view 的 tasks、processPresenter 的 subProcesses）。 */
const hides = (code: string, field: string, options: IdpMockOptions) => {
  const viewable = options.fields?.[code]?.viewable;
  return !!viewable && !viewable.includes(field);
};
/** 详情里的嵌套记录同样按各自对象的字段权限裁剪（目标、任务、综述、回顾、子流程）。 */
function trimDetail<T extends ReturnType<typeof planDetail>>(detail: T, options: IdpMockOptions): T {
  return {
    ...detail,
    goals: detail.goals.map((goal) => {
      const { tasks, ...rest } = trim('IDP.IdpGoal', goal, options);
      if (hides('IDP.IdpGoal', 'tasks', options)) return rest;
      return { ...rest, tasks: tasks.map((task) => trim('IDP.Task', task, options)) };
    }),
    analyses: detail.analyses.map((row) => trim('IDP.Analysis', row, options)),
    reviews: detail.reviews.map((row) => trim('IDP.Review', row, options)),
  };
}
function trimProcess(row: typeof process, options: IdpMockOptions) {
  const { subProcesses, ...rest } = trim('IDP.IDPProcess', row, options);
  if (hides('IDP.IDPProcess', 'subProcesses', options)) return rest;
  const subs = subProcesses.map((sub) => ({ ...sub, ...options.subProcess }));
  return { ...rest, subProcesses: subs.map((sub) => trim('IDP.SubProcess', sub, options)) };
}

/** 让演示身份看到 IDP 全部对象并按目录给出字段与按钮；返回记录到的 IDP 请求，供断言写请求次数与幂等键。 */
export async function mockIdp(page: Page, options: IdpMockOptions = {}) {
  const calls: IdpCall[] = [];
  const codes = Object.values(IDP_OBJECTS).map((object) => object.code);
  await page.route('**/api/tenant/permission/me/snapshot', (route) =>
    route.fulfill({
      json: {
        ...snapshotFixture,
        apps: snapshotFixture.apps.map((app) => (app.app === 'idp' ? { ...app, entryObjects: codes } : app)),
      },
    }),
  );
  await page.route('**/permission/me/objects/IDP.*', (route) => {
    const code = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    return route.fulfill({ json: objectPermission(code, options) });
  });
  const scoped = options.hasDataPermission ?? true;
  const list = (items: unknown[]) => ({
    page: 1,
    pageSize: 200,
    hasDataPermission: scoped,
    items: scoped ? items : [],
  });
  const detail = detailOf(options);
  const reads = staticReads(options, detail, list);
  const server = processServer(options);
  const plans = planServer(detail);
  const write = (route: Route, path: string, call: IdpCall) => {
    const status = calls.length <= (options.conflictTimes ?? 0) ? 409 : options.writeStatus;
    const code = status === 409 ? 'REVISION_CONFLICT' : 'INTERNAL';
    if (status === 409) server.conflict();
    if (status === 409 && path === plans.content) plans.conflict();
    if (status) return route.fulfill({ status, json: { error: { code } } });
    if (path === plans.content) return route.fulfill({ json: reviewReceipt(plans.save(call), call, options) });
    if (path.includes('/tasks')) return route.fulfill({ status: path.endsWith('/tasks') ? 201 : 200, json: detail });
    if (path.endsWith('/copy')) return route.fulfill({ status: 201, json: { ...template, id: approvalId } });
    if (path.startsWith('/processes')) return route.fulfill({ json: server.save(call) });
    return route.fulfill({ json: path.startsWith('/plans') ? detail : template });
  };
  await page.route('**/api/tenant/idp/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/tenant\/idp/, '');
    if (request.method() !== 'GET') {
      const call: IdpCall = {
        method: request.method(),
        path,
        body: request.postData() ? request.postDataJSON() : null,
        key: request.headers()['idempotency-key'] ?? null,
        revision: request.headers()['if-match'] ?? null,
      };
      calls.push(call);
      return write(route, path, call);
    }
    // 模板除基本信息外没有模块：任何查看人打开都 403（plan-access requireVisibleModule）
    if (path === `/plans/${basicOnlyId}`) return route.fulfill({ status: 403, json: NO_VISIBLE_MODULE });
    const json = server.read(path) ?? plans.read(path) ?? reads[path] ?? list([]);
    return route.fulfill({ json: calls.length ? reread(path, json, options) : json });
  });
  if (options.reviewApproval) await mockReviewApproval(page, calls, options);
  await mockNames(page);
  return calls;
}

/** 回顾所在阶段的审批实例：详情读取与本人待办的同意；同意记进 calls（路径带 /approval 前缀）。 */
async function mockReviewApproval(page: Page, calls: IdpCall[], options: IdpMockOptions) {
  let revision = 7;
  let done = false;
  const assignee = options.reviewApproval === 'others' ? otherUser : user;
  await page.route(`**/api/tenant/approval/instances/${reviewInstanceId}`, (route) =>
    route.fulfill({ json: reviewApprovalDetail(revision, done, assignee) }),
  );
  await page.route(`**/api/tenant/approval/tasks/${reviewTaskId}/approve`, (route) => {
    const request = route.request();
    calls.push({
      method: request.method(),
      path: `/approval/tasks/${reviewTaskId}/approve`,
      body: request.postDataJSON(),
      key: request.headers()['idempotency-key'] ?? null,
      revision: request.headers()['if-match'] ?? null,
    });
    revision += 1;
    done = true;
    const stale = options.approveReceipt === 'stale-revision';
    return route.fulfill({ json: reviewApprovalDetail(stale ? revision - 1 : revision, done) });
  });
}

type ListOf = (items: unknown[]) => unknown;
/** 静态读取表：列表与详情按路径返回（计划详情另由 planServer 按写入结果给出）。 */
function staticReads(
  options: IdpMockOptions,
  detail: ReturnType<typeof planDetail>,
  list: ListOf,
): Record<string, unknown> {
  return {
    '/plans': list([plan, waiting].map((row) => trim('IDP.Idp', row, options))),
    // DEC-611：本人 / 指导人的行带 tutorEmployeeId 与 tutorName，不含指导人角色与流程。
    '/my-plans': {
      page: 1,
      pageSize: 200,
      items: [plan, participating, { ...plan, id: basicOnlyId, name: '合成基本信息计划' }].map(participantRow),
    },
    '/tutor-plans': {
      page: 1,
      pageSize: 200,
      items: [
        tutorRow(otherPlanId, '合成参与计划', otherEmployee),
        tutorRow(tutoredId, '合成辅导计划', thirdEmployee),
        tutorRow(basicOnlyId, '合成基本信息计划', thirdEmployee),
      ],
    },
    [`/plans/${planId}`]: detail,
    [`/plans/${waitingId}`]: { ...detail, ...waiting },
    [`/plans/${otherPlanId}`]: { ...detail, ...participating },
    '/templates': list([trim('IDP.IDPTemplate', template, options)]),
    [`/templates/${templateId}`]: template,
    '/processes': list([trimProcess(process, options)]),
    [`/processes/${processId}`]: trimProcess(process, options),
    '/approval-processes': {
      items: [
        {
          id: approvalId,
          name: '合成审批流程',
          approvalType: 'idp_plan',
          nodes: [{ nodeKey: 'n1', name: '制定发展目标', seq: 1 }],
        },
      ],
    },
  };
}

const NO_VISIBLE_MODULE = {
  error: { code: 'FORBIDDEN', message: '无权限查看当前发展计划', details: { reason: 'IDP_PLAN_NO_VISIBLE_MODULE' } },
};

/**
 * 计划的服务端记录（F-155b 回顾）：PUT 模块内容成功时按请求体（去首尾空白，空串存 null）改写运行中阶段那一份并进版本，
 * 返回完整详情（plan-routes respondPlan），之后的详情读取反映写入；冲突时先被别人保存过一次。
 */
function planServer(detail: ReturnType<typeof planDetail>) {
  let stored = detail;
  const stageId = stages.find((row) => row.status === 'running')!.id;
  const store = (values: Record<string, unknown>) => {
    const key = (row: { moduleId: string; stageId: string }) =>
      row.moduleId === reviewModuleId && row.stageId === stageId;
    const prior = stored.reviews.find(key) ?? { moduleId: reviewModuleId, stageId, summary: null, improvement: null };
    const clean = Object.fromEntries(
      Object.entries(values).map(([field, value]) => [field, typeof value === 'string' ? value.trim() || null : value]),
    );
    const reviews = [...stored.reviews.filter((row) => !key(row)), { ...prior, ...clean }];
    stored = { ...stored, revision: stored.revision + 1, reviews } as typeof stored;
    return stored;
  };
  return {
    content: `/plans/${planId}/modules/${reviewModuleId}/content`,
    conflict: () => store({ summary: '合成他人保存的总结' }),
    save: (call: IdpCall) => store(call.body as Record<string, unknown>),
    read: (path: string) => (path === `/plans/${planId}` ? stored : undefined),
  };
}

function reviewReceipt(saved: Record<string, unknown>, call: IdpCall, options: IdpMockOptions) {
  if (options.reviewReceipt === 'stale-revision') return { ...saved, revision: Number(call.revision) };
  if (options.reviewReceipt !== 'without-revision') return saved;
  const { revision: _revision, ...rest } = saved;
  return rest;
}

/** 流程的服务端记录：只在 processVersions 模式下随冲突换版本、随成功写入合并请求体，其余情况沿用静态夹具。 */
function processServer(options: IdpMockOptions) {
  const versions = options.processVersions;
  let stored: Record<string, unknown> = process;
  let conflicts = 0;
  const next = (values: Record<string, unknown>) => ({ ...values, revision: (stored.revision as number) + 1 });
  return {
    conflict() {
      const version = versions?.[conflicts++];
      if (version) stored = next(version);
    },
    save(call: IdpCall) {
      if (!versions) return { ...process, revision: process.revision + 1 };
      stored = next({ ...stored, ...(call.body as Record<string, unknown>) });
      call.stored = stored;
      return stored;
    },
    read: (path: string) => (versions && path === `/processes/${processId}` ? stored : undefined),
  };
}

/** 发生过写请求后的详情重读：按选项去掉 revision，或把子流程裁掉指定键（模拟冲突后重读到的被裁剪版本）。 */
function reread(path: string, json: unknown, options: IdpMockOptions) {
  if (options.rereadWithoutRevision && /^\/(plans|templates|processes)\/[^/]+$/.test(path)) {
    const { revision: _revision, ...rest } = json as { revision?: number };
    return rest;
  }
  const omit = options.rereadSubProcessOmit;
  if (!omit || path !== `/processes/${processId}`) return json;
  const { subProcesses = [], ...rest } = json as { subProcesses?: Record<string, unknown>[] };
  const subs = subProcesses.map((sub) =>
    Object.fromEntries(Object.entries(sub).filter(([key]) => !omit.includes(key))),
  );
  return { ...rest, revision: process.revision + 1, subProcesses: subs };
}

/** 名称回查与候选列表：员工 / 组织模块的读接口，返回合成名称。 */
async function mockNames(page: Page) {
  const names: Record<string, string> = {
    [employee]: '合成员工甲',
    [otherEmployee]: '合成员工乙',
    [thirdEmployee]: '合成员工丙',
    [orgId]: '合成研发部',
  };
  await page.route(/\/api\/tenant\/(employment\/employees|org\/organizations)\/[^/?]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    return names[id] ? route.fulfill({ json: { id, name: names[id] } }) : route.fulfill({ status: 404, json: {} });
  });
  // 候选列表：员工 / 组织选择器的分页读取
  const choices = (ids: string[]) => ({ page: 1, pageSize: 20, items: ids.map((id) => ({ id, name: names[id] })) });
  await page.route(/\/api\/tenant\/employment\/employees(\?.*)?$/, (route) =>
    route.fulfill({ json: choices([employee, otherEmployee]) }),
  );
  await page.route(/\/api\/tenant\/org\/organizations(\?.*)?$/, (route) => route.fulfill({ json: choices([orgId]) }));
}
