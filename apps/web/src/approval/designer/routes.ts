/**
 * F-478 S7 节点出口分支的表单值（设计 §1.4、§2.2）：读回形状核对、本地完整性检查与按 S2 契约规整。
 * 语义校验（优先级重复、缺 Else、去向回指等）只在服务端做，400 `details.reason` 由 locate.ts 定位回节点与分支。
 */
import {
  BUSINESS_EXIT_LABELS,
  EXIT_LABELS,
  MAX_ROUTE_PRIORITY,
  ROUTE_END,
  type ApprovalNode,
  type ConditionField,
  type ConditionItem,
  type ExitRoute,
  type RouteBranch,
} from '@italent/domain';
import { ApiError } from '../../foundation/client.js';
import { m } from './messages.js';
import { r } from './route-messages.js';

export const LIST_OPERATORS: readonly string[] = ['in', 'not_in'];
export const EMPTY_OPERATORS: readonly string[] = ['is_empty', 'not_empty'];
const KINDS: readonly string[] = ['condition', 'else', 'direct'];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** 本地拦截的分支错误带上节点，页面据此切到出错节点。 */
export class RouteInputError extends ApiError {
  constructor(
    readonly nodeKey: string,
    message: string,
    readonly exit?: string,
    readonly branchNo?: number,
  ) {
    super(422, 'INVALID_NODE_PROPERTY', 'fields', message);
  }
}
export const exitLabel = (exit: string) =>
  (EXIT_LABELS as Record<string, string>)[exit] ?? (BUSINESS_EXIT_LABELS as Record<string, string>)[exit] ?? exit;

function itemShape(item: unknown) {
  return (
    isRecord(item) &&
    typeof item.no === 'number' &&
    typeof item.field === 'string' &&
    typeof item.operator === 'string' &&
    (item.value === null || typeof item.value === 'string' || strings(item.value))
  );
}
function branchShape(branch: unknown) {
  if (!isRecord(branch) || !KINDS.includes(String(branch.kind)) || typeof branch.target !== 'string') return false;
  if (branch.kind !== 'condition') return true;
  const conditions = branch.conditions;
  return (
    typeof branch.priority === 'number' &&
    isRecord(conditions) &&
    typeof conditions.expression === 'string' &&
    Array.isArray(conditions.items) &&
    conditions.items.every(itemShape)
  );
}
/** 读回形状：整份替换不能补默认值，形状不全时整份定义只读（REQ-APV-001）。 */
export function routesShape(value: unknown): value is ExitRoute[] {
  return (
    Array.isArray(value) &&
    value.every((route) => isRecord(route) && typeof route.exit === 'string' && Array.isArray(route.branches)) &&
    value.every((route: { branches: unknown[] }) => route.branches.every(branchShape))
  );
}

function branchIssue(value: unknown) {
  const branch = isRecord(value) ? value : {};
  if (typeof branch.target !== 'string' || !branch.target) return r.missingTarget;
  const priority = branch.priority;
  const ranked = Number.isSafeInteger(priority) && Number(priority) >= 1 && Number(priority) <= MAX_ROUTE_PRIORITY;
  if (branch.kind === 'condition' && !ranked) return r.missingPriority;
  if (!branchShape(branch)) return r.invalidRoute;
  const items = (branch as Partial<RouteBranch>).conditions?.items ?? [];
  return items.some((item) => !item.field || !item.operator) ? r.missingItem : undefined;
}
/** 只拦“没选完”的输入；其余（含空条件）交给服务端按 reason 拒绝，避免前后端两套语义规则。 */
export function routesInputError(value: unknown, node: ApprovalNode): RouteInputError | undefined {
  const fail = (issue: string, exit?: string, no?: number) =>
    new RouteInputError(node.key, `${r.at(node.name, exit && exitLabel(exit), no)}：${issue}`, exit, no);
  if (!Array.isArray(value)) return fail(r.invalidRoute);
  for (const route of value as unknown[]) {
    if (!isRecord(route) || typeof route.exit !== 'string' || !Array.isArray(route.branches))
      return fail(r.invalidRoute);
    for (const [index, branch] of route.branches.entries()) {
      const issue = branchIssue(branch);
      if (issue) return fail(issue, route.exit, index + 1);
    }
  }
  return undefined;
}

function itemValue(item: ConditionItem): ConditionItem['value'] {
  if (EMPTY_OPERATORS.includes(item.operator)) return null;
  if (LIST_OPERATORS.includes(item.operator)) return Array.isArray(item.value) ? [...item.value] : [];
  return typeof item.value === 'string' ? item.value : '';
}
function normalizeBranch(branch: RouteBranch): RouteBranch {
  if (branch.kind !== 'condition') return { kind: branch.kind, target: branch.target };
  const expression = branch.conditions?.expression.trim() ?? '';
  // 表达式按条件编号引用：留空时按顺序重新编号，写了表达式就保留编号，避免改变用户写下的引用。
  const items = (branch.conditions?.items ?? []).map((item, index) => ({
    no: expression ? item.no : index + 1,
    field: item.field,
    operator: item.operator,
    value: itemValue(item),
  }));
  return { kind: 'condition', priority: branch.priority, conditions: { expression, items }, target: branch.target };
}
/** 按 S2 契约提交：没有分支的出口不发（zod 要求至少一个分支），显式清空发 []。 */
export function normalizeRoutes(routes: readonly ExitRoute[]): ExitRoute[] {
  return routes
    .filter((route) => route.branches.length)
    .map((route) => ({ exit: route.exit, branches: route.branches.map(normalizeBranch) }));
}

/** 冲突差异与回查表格里的可读摘要；内核仍按原始值比较。 */
export function routesSummary(value: unknown, nodes: readonly ApprovalNode[], fields: readonly ConditionField[]) {
  if (!routesShape(value)) return value;
  if (!value.length) return r.none;
  const target = (key: string) => (key === ROUTE_END ? r.end : (nodes.find((node) => node.key === key)?.name ?? key));
  const field = (path: string) => fields.find((item) => item.path === path)?.label ?? path;
  const item = (entry: ConditionItem) =>
    [field(entry.field), m.values[entry.operator] ?? entry.operator, [entry.value ?? ''].flat().join('、')]
      .filter(Boolean)
      .join(' ');
  const branch = (entry: RouteBranch) =>
    entry.kind === 'condition'
      ? `${r.priority} ${entry.priority}：${entry.conditions?.items.map(item).join('；')} → ${target(entry.target)}`
      : `${r.kinds[entry.kind]} → ${target(entry.target)}`;
  return value.map((route) => `${exitLabel(route.exit)}：${route.branches.map(branch).join('，')}`).join('\n');
}
