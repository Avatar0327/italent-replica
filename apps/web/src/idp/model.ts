import type { PlanStatus } from '@italent/domain';
import { t } from './messages.js';
import type { PlanSummary, Receipt, Stage } from './types.js';

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
  startFrom?: string;
  endTo?: string;
}

/** 页签与筛选在完整读取的授权结果上进行（后端只支持按状态筛选，DEC-494 列表读取约定）。 */
export function filterPlans(rows: readonly PlanSummary[], view: PlanView, filters: PlanFilters) {
  const name = filters.name?.trim();
  return rows.filter(
    (row) =>
      !!row.status &&
      PLAN_VIEWS[view].includes(row.status) &&
      (!name || (row.name ?? '').includes(name)) &&
      (!filters.status || row.status === filters.status) &&
      (!filters.tutorRole || row.tutorRole === filters.tutorRole) &&
      // 日期是租户业务日期字符串（YYYY-MM-DD），按字典序比较即可，不经浏览器时区（DEC-056）
      (!filters.startFrom || (!!row.startDate && row.startDate >= filters.startFrom)) &&
      (!filters.endTo || (!!row.endDate && row.endDate <= filters.endTo)),
  );
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
/** 只显示“状态允许 ∩ 后端授予按钮”的操作；revision 缺失时无法带并发版本，不给写操作。 */
export function planActions(plan: PlanSummary, can: (button: PlanAction) => boolean): PlanAction[] {
  if (plan.revision === undefined || !plan.status) return [];
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
  const eligible = rows.filter((row) => row.revision !== undefined && ELIGIBLE[action](row));
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
