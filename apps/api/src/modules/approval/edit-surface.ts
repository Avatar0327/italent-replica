/**
 * 审批中编辑的单一入口（F-291，DEC-655）：详情下发 form.edit、详情公布的 edit 动作、命令侧「同意带 fields / 独立编辑」
 * 的前置检查与字段集合，三处共用本文件的判定，不各写一套；必填来源是 domain 的 APPROVAL_EDIT_REQUIRED。纯函数，无 IO。
 */
import {
  APPROVAL_EDIT_REQUIRED,
  APPROVAL_TYPES,
  hasExit,
  type ApprovalNode,
  type ApprovalTypeCode,
} from '@italent/domain';
import type { Row } from './context.js';
import { addSignLink } from './rules.js';
import type { TaskRow } from './store.js';

/** 本任务不能编辑的原因：类型不开放（DEC-105，员工信息类）→ unsupported；加签人（`14` §11.3）→ add_signer。 */
export function editBlocker(
  approvalType: ApprovalTypeCode,
  tasks: readonly TaskRow[],
  task: TaskRow,
): 'unsupported' | 'add_signer' | null {
  if (!APPROVAL_TYPES[approvalType].approvalEdit) return 'unsupported';
  return addSignLink(tasks, task) ? 'add_signer' : null;
}

/** 节点开放且查看人可见的可编辑字段（节点 editableFields 顺序）；viewable 为 undefined 表示不受字段权限限制。 */
export function editableKeys(node: ApprovalNode, viewable: ReadonlySet<string> | undefined): string[] {
  return node.editableFields.filter((key) => viewable === undefined || viewable.has(key));
}

/** 空值：未填、null 或全空白字符串。 */
export const isBlank = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

export interface EditSurface {
  readonly taskId: string;
  readonly mode: 'with_approve' | 'separate';
  readonly fields: { key: string; required: boolean; value: unknown }[];
}

/** 本人待办任务上的可编辑表单；不可编辑（类型不开放 / 加签人 / editMode=none / 无同意出口 / 交集为空）返回 null。 */
export function editSurface(input: {
  readonly approvalType: ApprovalTypeCode;
  readonly node: ApprovalNode;
  readonly tasks: readonly TaskRow[];
  readonly mine: TaskRow;
  readonly values: Readonly<Row>;
  readonly viewable: ReadonlySet<string> | undefined;
}): EditSurface | null {
  const { approvalType, node, mine } = input;
  if (node.editMode === 'none' || editBlocker(approvalType, input.tasks, mine)) return null;
  if (node.editMode === 'with_approve' && !hasExit(node, 'approve')) return null;
  const keys = editableKeys(node, input.viewable);
  if (!keys.length) return null;
  const required = APPROVAL_EDIT_REQUIRED[approvalType] ?? {};
  return {
    taskId: mine.id,
    mode: node.editMode,
    fields: keys.map((key) => ({ key, required: Object.hasOwn(required, key), value: input.values[key] ?? null })),
  };
}
