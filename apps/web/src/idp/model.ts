import type { PlanStatus } from '@italent/domain';
import { operationAccess, writeIntegrity } from './access.js';
import { t } from './messages.js';
import type {
  GoalTask,
  PlanGoal,
  PlanModule,
  PlanSummary,
  Process,
  Receipt,
  Stage,
  SubProcess,
  Template,
} from './types.js';

export type PlanView = 'active' | 'ended' | 'terminated';
export const PLAN_VIEWS: Record<PlanView, readonly PlanStatus[]> = {
  active: ['not_started', 'running'],
  ended: ['ended'],
  terminated: ['terminated'],
};
export interface PlanFilters {
  name?: string;
  status?: PlanStatus;
  tutorRole?: string;
  employeeId?: string;
  tutorEmployeeId?: string;
  currentStageName?: string;
  startFrom?: string;
  endTo?: string;
}

/** 状态字段被裁剪（无权查看）时，记录照常出现在每个页签，不能因此整条消失（DEC-431①）。 */
const inPlanView = (row: PlanSummary, view: PlanView) => !row.status || PLAN_VIEWS[view].includes(row.status);
const matches = (expected: string | undefined, actual: string | null | undefined) => !expected || actual === expected;

/** 筛选条件逐项判定；显式按某个值筛选时，字段不可见的记录无法判断是否命中，按不命中处理。 */
export function matchesFilters(row: PlanSummary, filters: PlanFilters) {
  const name = filters.name?.trim();
  return (
    (!name || (row.name ?? '').includes(name)) &&
    matches(filters.status, row.status) &&
    matches(filters.tutorRole, row.tutorRole) &&
    matches(filters.employeeId, row.employeeId) &&
    matches(filters.tutorEmployeeId, row.tutorEmployeeId) &&
    matches(filters.currentStageName, row.currentStageName) &&
    // 日期是租户业务日期字符串（YYYY-MM-DD），按字典序比较即可，不经浏览器时区（DEC-056）
    (!filters.startFrom || (!!row.startDate && row.startDate >= filters.startFrom)) &&
    (!filters.endTo || (!!row.endDate && row.endDate <= filters.endTo))
  );
}

/** 页签与筛选在完整读取的授权结果上进行（后端只支持按状态筛选，DEC-494 列表读取约定）。 */
export function filterPlans(rows: readonly PlanSummary[], view: PlanView, filters: PlanFilters) {
  return rows.filter((row) => inPlanView(row, view) && matchesFilters(row, filters));
}

export type PlanAction = 'update' | 'delete' | 'start' | 'urge' | 'jump' | 'transfer' | 'startNext' | 'terminate';
/** 各状态允许的操作（docs/02_业务建模/28 IDP-R14 / R16；后端 plan-service 同口径）。 */
const ALLOWED: Record<PlanStatus, readonly PlanAction[]> = {
  not_started: ['update', 'delete', 'start', 'terminate'],
  running: ['update', 'delete', 'urge', 'jump', 'transfer', 'startNext', 'terminate'],
  ended: ['delete'],
  terminated: ['delete'],
};
/** 各按钮的授权层级（packages/domain IDP_OBJECTS.plan.buttons；canButton 要求层级完全一致）。 */
export const BUTTON_LEVEL: Record<PlanAction, 'list' | 'detail'> = {
  update: 'detail',
  delete: 'detail',
  start: 'detail',
  urge: 'list',
  jump: 'detail',
  transfer: 'detail',
  startNext: 'list',
  terminate: 'list',
};
/** 行命令路径带 id、请求带 revision：任一被裁剪就无法定位或带并发版本（写入完整性统一判定）。 */
const commandable = (row: { id?: string; revision?: number }) =>
  writeIntegrity({ rows: [row], fields: ['revision'] }).ok;
/** 只显示“状态允许 ∩ 后端授予按钮”的操作；id 或 revision 缺失时不给写操作。 */
export function planActions(plan: PlanSummary, can: (button: PlanAction) => boolean): PlanAction[] {
  if (!commandable(plan) || !plan.status) return [];
  return ALLOWED[plan.status].filter(can);
}

export type BatchAction = 'urge' | 'startNext' | 'terminate';
const ELIGIBLE: Record<BatchAction, (plan: PlanSummary) => boolean> = {
  // 催办只对进行中阶段的待办生效
  urge: (plan) => plan.status === 'running' && !!plan.stages?.some((stage) => stage.status === 'running'),
  startNext: (plan) => plan.status === 'running' && !!nextStage(plan.stages ?? []),
  terminate: (plan) => plan.status === 'not_started' || plan.status === 'running',
};
/** 批量干预前先在前端剔除明显不可执行的计划；服务端仍逐条判定并返回回执。 */
export function batchSplit(rows: readonly PlanSummary[], action: BatchAction) {
  const eligible = rows.filter((row) => commandable(row) && ELIGIBLE[action](row));
  return { eligible, skipped: rows.filter((row) => !eligible.includes(row)) };
}

export function nextStage(stages: readonly Stage[]): Stage | undefined {
  return [...stages].sort((a, b) => a.seq - b.seq).find((stage) => stage.status === 'pending');
}

export function receiptSummary(receipts: readonly Receipt[]) {
  const done = receipts.filter((receipt) => receipt.status < 300 && receipt.outcome !== 'failed').length;
  return { done, failed: receipts.length - done };
}

type Values = Record<string, unknown>;
const idOf = (value: unknown) =>
  value && typeof value === 'object' && 'value' in value ? String((value as { value: unknown }).value) : value;
/**
 * 计划表单 → 请求体：只带可编辑字段；人员选择器的 {value,label} 取 ID；空值不提交。
 * 日期顺序与“其他人须选指导人”在前端先校验（plan-input.ts 同规则），服务端仍是最终判定。
 */
export function planInput(values: Values, editable: readonly string[]) {
  const body: Values = {};
  for (const field of editable) {
    let value = idOf(values[field]);
    if (typeof value === 'string') value = value.trim();
    if (value === undefined || value === null || value === '') continue;
    body[field] = value;
  }
  const errors: Record<string, string> = {};
  const start = values.startDate as string | undefined;
  const end = values.endDate as string | undefined;
  if (start && end && end < start) errors.endDate = t.dateOrder;
  if (values.tutorRole === 'other' && !idOf(values.tutorEmployeeId)) errors.tutorEmployeeId = t.tutorRequired;
  return { body, errors };
}

export const display = (value: unknown) =>
  value === undefined || value === null || value === '' ? t.noValue : String(value);
export const period = (start?: string, end?: string) =>
  start || end ? `${(start ?? t.noValue).replaceAll('-', '.')}-${(end ?? t.noValue).replaceAll('-', '.')}` : t.noValue;

/** 状态位：字段被裁剪时显示“无权查看”，与“空值”区分（DEC-431①）。 */
export const statusText = (labels: Record<string, string>, status?: string | null) =>
  status === undefined ? t.noAccess : (labels[status ?? ''] ?? display(status));

/**
 * 我的发展计划只列本人作为被发展人的计划（原站 04）；作为指导人 / 审批人参与的计划从待办与审批中心进入。
 * 会话没有员工身份时为空（失败即拒绝）。
 */
export const ownPlans = (rows: readonly PlanSummary[], employeeId?: string) =>
  employeeId ? rows.filter((row) => row.employeeId === employeeId) : [];

export type TemplateView = 'published' | 'draft';
export const templateInView = (row: Pick<Template, 'status'>, view: TemplateView) => !row.status || row.status === view;
export type ProcessView = 'enabled' | 'disabled';
export const processInView = (row: Pick<Process, 'enabled'>, view: ProcessView) =>
  row.enabled === undefined || row.enabled === (view === 'enabled');

export type TemplateAction = 'update' | 'copy' | 'publish' | 'unpublish' | 'delete';
const TOGGLE: Record<string, TemplateAction[]> = { published: ['unpublish'], draft: ['publish'] };
/** 模板行操作：状态未知时不给启用 / 停用（无法判断方向）；id 或 revision 缺失时不给任何写操作。 */
export function templateActions(
  row: Partial<Pick<Template, 'id' | 'revision' | 'status'>>,
  can: (action: TemplateAction) => boolean,
) {
  if (!commandable(row)) return [];
  const toggle = TOGGLE[row.status ?? ''] ?? [];
  return (['update', 'copy', ...toggle, 'delete'] as TemplateAction[]).filter(can);
}

export type ProcessAction = 'update' | 'delete';
/**
 * 流程行操作：编辑按行 id 读详情拿 revision，只要 id；删除直接用行 id 与 revision，缺失时不给（失败即拒绝）。
 */
export function processActions(
  row: Partial<Pick<Process, 'id' | 'revision'>>,
  can: (action: ProcessAction) => boolean,
) {
  const fields = { update: [], delete: ['revision'] };
  return (['update', 'delete'] as const).filter(
    (action) => can(action) && writeIntegrity({ rows: [row], fields: fields[action] }).ok,
  );
}

export type TaskAction = 'add' | 'edit' | 'delete';
/**
 * 任务的增删改由后端按当前节点的 RowEditIdpGoal 且模块开启“制定任务”（task_enabled）复核（plan-routes 任务接口），
 * 前端同口径经统一入口 operationAccess 判定：计划进行中、带 revision、模块 taskEnabled 明确为 true、
 * 服务端在模块上返回了该按钮，缺一不开放。参与人视图未返回 taskEnabled 时拒绝并给出原因，不由按钮推断已开启；
 * HR 视图不返回节点按钮，不开放。
 */
export function taskActions(plan: PlanSummary, module: PlanModule): { actions: TaskAction[]; reason?: string } {
  const executor = module.buttons?.includes('RowEditIdpGoal') === true;
  const access = operationAccess({
    operations: { create: executor, update: executor, delete: executor },
    editable: ['name', 'description'],
    required: ['name'],
    switches: [plan.status === 'running', commandable(plan), module.taskEnabled],
  });
  const actions = (['add', 'edit', 'delete'] as const).filter((action) =>
    action === 'delete' ? access.remove : access[action],
  );
  if (executor && module.taskEnabled == null) return { actions, reason: t.task.switchUnknown };
  return { actions };
}

/**
 * 任务逐条写入，路径带目标 id 与任务 id（plan-routes 任务接口）：目标 id 缺失时全部不开放；
 * 任务 id 缺失时该行不能编辑、删除；名称被裁剪时编辑框只能空着重填、会覆盖看不到的原值，不开放编辑。
 * 不传任务时给目标级操作（添加）。判定走统一入口 writeIntegrity。
 */
export function taskRowActions(
  actions: readonly TaskAction[],
  goal: Partial<Pick<PlanGoal, 'id'>>,
  task?: Partial<Pick<GoalTask, 'id' | 'name'>>,
): TaskAction[] {
  if (!writeIntegrity({ rows: [goal] }).ok) return [];
  if (!task) return actions.filter((action) => action === 'add');
  const fields: Record<TaskAction, string[]> = { add: [], edit: ['name'], delete: [] };
  return actions.filter((action) => action !== 'add' && writeIntegrity({ rows: [task], fields: fields[action] }).ok);
}

/** 新增子流程必须能填写的字段（process-service 子流程必填项）。 */
const SUB_PROCESS_REQUIRED = ['name', 'category', 'approvalType', 'approvalProcessId', 'startMode'];
export const SUB_PROCESS_FIELDS = [
  ...SUB_PROCESS_REQUIRED,
  'startTimeType',
  'fixedDate',
  'referencePoint',
  'startFrom',
  'days',
] as const;
type FieldAccess = (field: string) => { visible: boolean; editable: boolean };
/**
 * 子流程按 IDP.SubProcess 自身字段权限与操作权（dataOperations）渲染，并以父对象的 subProcesses 字段可编辑为前提；
 * 判定走统一入口 operationAccess：移除要 delete，排序 / 编辑要 update，新增要 create（process-service 同口径），
 * 任一条件不满足即只读（失败即拒绝），隐藏字段不出现在可见字段里。
 * 子流程整组提交：已有元素缺 id 会被当成新建（原记录被删），必填字段缺省 400、开启规则字段缺省被补成 null
 * 且要求可见（routes requireSubProcessInputVisible）。所以 rows（已有子流程）经 writeIntegrity 判为不完整时整组只读，
 * 父字段可编辑时给出原因。
 */
export function subProcessAccess(
  parentEditable: boolean,
  field: FieldAccess,
  operations: Readonly<Record<string, boolean>> | undefined,
  rows?: readonly SubProcess[],
) {
  const visible = SUB_PROCESS_FIELDS.filter((name) => field(name).visible);
  const editable = parentEditable ? visible.filter((name) => field(name).editable) : [];
  const integrity = writeIntegrity({ rows, fields: SUB_PROCESS_FIELDS, visible });
  const access = operationAccess({
    operations,
    editable,
    required: SUB_PROCESS_REQUIRED,
    switches: [parentEditable, visible.length > 0, integrity.ok],
  });
  const reason = parentEditable && !integrity.ok ? integrity.reason : undefined;
  // complete 为 false 时整组只读、原样不提交，页面不再按缺字段的数据校验开启规则
  return { ...access, visible: visible as string[], editable: editable as string[], reason, complete: integrity.ok };
}
