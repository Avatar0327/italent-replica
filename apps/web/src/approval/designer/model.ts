import type { ApprovalNode, ProcessDefinition } from '@italent/domain';
import type { ProcessView, VersionView } from '../../../../api/src/modules/approval/definitions.js';
import { ApiError } from '../../foundation/client.js';
import type { ObjectPermission } from '../../foundation/permission-model.js';
import type { Values } from '../../foundation/forms/store.js';
import { m } from './messages.js';

export type { ProcessView, VersionView, ProcessSummary } from '../../../../api/src/modules/approval/definitions.js';
export const base = '/api/tenant/approval/processes';
export const root = '/config-center/workflow/processes';
export const processObject = 'TenantBase.ApprovalProcess';
export const attributes = Object.keys(m.fields) as (keyof typeof m.fields)[];
export const nodeField = (key: string, field: string) => `${encodeURIComponent(key)}:${field}`;
export const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');
const nullableText = (value: unknown) => value === null || typeof value === 'string';

/** 整份替换接口不能用裁剪后的 DTO 补默认值。必需内容未读取时只读（REQ-APV-001）。 */
export function completeDefinition(value: unknown): value is VersionView {
  if (!record(value)) return false;
  return (
    typeof value.name === 'string' &&
    ['groupName', 'description', 'exceptionAdminUserId'].every((k) => nullableText(value[k])) &&
    typeof value.priority === 'number' &&
    Number.isSafeInteger(value.priority) &&
    ['isFallback', 'urgeEnabled', 'hideRecordsFromInitiator'].every((k) => typeof value[k] === 'boolean') &&
    record(value.conditions) &&
    typeof value.conditions.expression === 'string' &&
    Array.isArray(value.conditions.items) &&
    value.conditions.items.every(
      (item: unknown) =>
        record(item) &&
        typeof item.no === 'number' &&
        typeof item.field === 'string' &&
        typeof item.operator === 'string' &&
        (nullableText(item.value) || strings(item.value)),
    ) &&
    Array.isArray(value.nodes) &&
    value.nodes.every(completeNode) &&
    new Set(value.nodes.map((node: ApprovalNode) => node.key)).size === value.nodes.length
  );
}
function completeNode(node: unknown): node is ApprovalNode {
  if (!record(node) || !record(node.actions)) return false;
  const kind =
    node.kind === 'single'
      ? record(node.approver) && typeof node.approver.type === 'string' && typeof node.approver.value === 'string'
      : node.kind === 'countersign' &&
        Array.isArray(node.approvers) &&
        node.approvers.every((s: unknown) => record(s) && typeof s.type === 'string' && typeof s.value === 'string') &&
        record(node.transitionRule) &&
        typeof node.transitionRule.type === 'string' &&
        record(node.transitionRule.rules);
  return (
    !!kind &&
    [
      'key',
      'name',
      'noAssignee',
      'sameAssigneeResult',
      'historySameAssigneeResult',
      'editMode',
      'rejectResubmit',
    ].every((k) => typeof node[k] === 'string') &&
    ['sameAssigneeSkip', 'historySameAssigneeSkip', 'rejectCommentRequired', 'hideRecords'].every(
      (k) => typeof node[k] === 'boolean',
    ) &&
    ['formFields', 'editableFields', 'exits'].every((k) => strings(node[k])) &&
    ['transfer', 'addSign', 'copySend', 'retrieve', 'reject', 'avoidSelf', 'avoidSubjects'].every(
      (k) => typeof (node.actions as Values)[k] === 'boolean',
    ) &&
    typeof node.actions.urge === 'string' &&
    typeof node.avoidSubjectsResult === 'string' &&
    Array.isArray(node.messageRules) &&
    node.messageRules.every(
      (rule: unknown) =>
        record(rule) &&
        ['trigger', 'template', 'recipient'].every((k) => typeof rule[k] === 'string') &&
        strings(rule.channels),
    )
  );
}
export function editableValues(version: Pick<VersionView, 'nodes'>): Values {
  return Object.fromEntries(
    (version.nodes ?? []).flatMap((node) =>
      attributes.map((field) => [
        nodeField(node.key, field),
        field.startsWith('actions.')
          ? node.actions?.[field.slice(8) as keyof ApprovalNode['actions']]
          : node[field as keyof ApprovalNode],
      ]),
    ),
  );
}
/** P2-1：旧输入只允许恢复到相同版本的有序节点结构；属性变化交给表单内核核对。 */
export function assertDraftStructure(original: VersionView, latest: VersionView): void {
  if (
    latest.id !== original.id ||
    latest.status !== 'draft' ||
    !completeDefinition(latest) ||
    !Array.isArray(original.nodes) ||
    latest.nodes.length !== original.nodes.length ||
    latest.nodes.some(
      (node, index) => node.key !== original.nodes[index]?.key || node.kind !== original.nodes[index]?.kind,
    )
  )
    throw new Error(m.versionChanged);
}
export function buildDraft(version: VersionView, edited: Values): ProcessDefinition {
  if (!completeDefinition(version)) throw new ApiError(422, 'INCOMPLETE_DEFINITION', 'fields', m.invalid);
  const allowed = new Set(Object.keys(editableValues(version)));
  for (const [field, value] of Object.entries(edited)) {
    const valid = field.endsWith(':name')
      ? typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100
      : typeof value === 'boolean';
    if (!allowed.has(field) || !valid) throw new ApiError(422, 'INVALID_NODE_PROPERTY', 'fields', m.invalid);
  }
  // 剔除版本元数据；未编辑配置取最新完整回执，不从最初打开时的版本复制。
  const { id: _id, versionNo: _number, status: _status, publishedAt: _at, ...definition } = structuredClone(version);
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      const values: Record<string, unknown> = { ...node };
      const actions = { ...node.actions };
      for (const field of attributes) {
        const key = nodeField(node.key, field);
        if (!(key in edited)) continue;
        if (field.startsWith('actions.')) Object.assign(actions, { [field.slice(8)]: edited[key] });
        else values[field] = field === 'name' ? (edited[key] as string).trim() : edited[key];
      }
      return { ...values, actions } as unknown as ApprovalNode;
    }),
  };
}
export function editAccess(permission: ObjectPermission | undefined, admin: boolean, button: string) {
  return !!(
    admin &&
    permission?.dataOperations.update &&
    permission.buttons.some((item) => item.buttonCode === button && item.level === 'detail') &&
    permission.viewableFields.includes('nodes') &&
    permission.editableFields.includes('nodes')
  );
}
export function validProcess(value: unknown, id: string): value is ProcessView {
  return (
    record(value) &&
    value.id === id &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    ['active', 'discarded'].includes(String(value.status)) &&
    record(value.latestVersion) &&
    typeof value.latestVersion.id === 'string' &&
    Number.isSafeInteger(value.latestVersion.versionNo) &&
    ['draft', 'published'].includes(String(value.latestVersion.status))
  );
}
/** 回执确认绑定实际提交版本；形状不符按结果未知锁定，不拿随后 GET 冒充命令确认。 */
export function acceptProcessReceipt(value: unknown, id: string, revision: number) {
  if (
    !validProcess(value, id) ||
    value.revision <= revision ||
    value.latestVersion.status !== 'draft' ||
    !completeDefinition(value.latestVersion)
  )
    throw new Error(m.invalidReceipt);
  return value;
}
