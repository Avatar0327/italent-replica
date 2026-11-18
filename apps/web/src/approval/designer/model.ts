import { approverSourcesOf, type ApprovalNode, type ExitRoute, type ProcessDefinition } from '@italent/domain';
import type { ProcessView, VersionView } from '../../../../api/src/modules/approval/definitions.js';
import { ApiError } from '../../foundation/client.js';
import { canButton, fieldAccess, type ObjectPermission } from '../../foundation/permission-model.js';
import type { Values } from '../../foundation/forms/store.js';
import { changedFields, sameValue } from '../../foundation/forms/values.js';
import { echoSource, echoSources, wireDraft } from './auto-variables.js';
import { supportsFallback, fallbackError } from './fallback.js';
import { m } from './messages.js';
import { normalizeRoutes, routesInputError, routesShape } from './routes.js';
import { sourceFields, sourceInputError, sourceShape, sourcesShape } from './sources.js';

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
      ? sourceShape(node.approver)
      : node.kind === 'countersign' &&
        sourcesShape(node.approvers) &&
        record(node.transitionRule) &&
        typeof node.transitionRule.type === 'string' &&
        record(node.transitionRule.rules);
  return (
    !!kind &&
    (node.emptyApproverSources === undefined || sourcesShape(node.emptyApproverSources)) &&
    (node.fallbackUserIds === undefined || strings(node.fallbackUserIds)) &&
    (node.routes === undefined || routesShape(node.routes)) &&
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
/** 节点进入表单内核的可编辑字段；F-478 S7 起含出口分支 routes（未配置读作空列表）。 */
const nodeFields = (node: ApprovalNode, approvalType?: string) => [
  ...attributes,
  ...sourceFields(node),
  'routes',
  ...(supportsFallback(node, approvalType) ? ['fallbackUserIds'] : []),
];
export function editableValues(version: Pick<VersionView, 'nodes'>, approvalType?: string): Values {
  return Object.fromEntries(
    (version.nodes ?? []).flatMap((node) =>
      nodeFields(node, approvalType).map((field) => [nodeField(node.key, field), nodeValue(node, field)]),
    ),
  );
}
function nodeValue(node: ApprovalNode, field: string) {
  if (field === 'routes') return structuredClone(node.routes ?? []);
  // S7b：本位置自动变量回显为指定人员（auto-variables.ts），未编辑也按回显值提交
  if (field === 'emptyApproverSources') return structuredClone(echoSources(node.emptyApproverSources ?? []));
  if (field === 'approvers' && 'approvers' in node) return structuredClone(echoSources(node.approvers));
  if (field === 'approver' && 'approver' in node) return structuredClone(echoSource(node.approver));
  if (field === 'fallbackUserIds') return Array.isArray(node.fallbackUserIds) ? [...node.fallbackUserIds] : [];
  if (field.startsWith('actions.')) return node.actions?.[field.slice(8) as keyof ApprovalNode['actions']];
  return node[field as keyof ApprovalNode];
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
      (node, index) =>
        node.key !== original.nodes[index]?.key ||
        node.kind !== original.nodes[index]?.kind ||
        (node.emptyApproverPolicy === 'specified') !== (original.nodes[index]?.emptyApproverPolicy === 'specified') ||
        supportsFallback(node, 'exit_handover') !== supportsFallback(original.nodes[index]!, 'exit_handover') ||
        // F-378：能兜底的节点，兜底人员绑定在“哪些来源、什么顺序”上，来源类型 + 值必须逐条一致。
        (supportsFallback(node, 'exit_handover') && !sameOrderedSources(node, original.nodes[index]!)),
    )
  )
    throw new Error(m.versionChanged);
}
const sameOrderedSources = (a: ApprovalNode, b: ApprovalNode) => {
  const [left, right] = [approverSourcesOf(a), approverSourcesOf(b)];
  return left.length === right.length && left.every((s, i) => s.type === right[i]!.type && s.value === right[i]!.value);
};
export function buildDraft(version: VersionView, edited: Values, approvalType?: string): ProcessDefinition {
  if (!completeDefinition(version)) throw new ApiError(422, 'INCOMPLETE_DEFINITION', 'fields', m.invalid);
  const allowed = new Set(Object.keys(editableValues(version, approvalType)));
  for (const [field, value] of Object.entries(edited)) {
    const issue = field.endsWith(':fallbackUserIds') ? fallbackError(value) : undefined;
    if (issue) throw new ApiError(422, 'INVALID_NODE_PROPERTY', 'fields', issue);
    const routed = field.endsWith(':routes') && version.nodes.find((item) => nodeField(item.key, 'routes') === field);
    if (routed) {
      const error = routesInputError(value, routed);
      if (error) throw error;
      continue;
    }
    const node = version.nodes.find((item) => sourceFields(item).some((name) => nodeField(item.key, name) === field));
    if (node) {
      const error = sourceInputError(value, node, approvalType, field.endsWith(':emptyApproverSources'));
      if (error) throw new ApiError(422, 'INVALID_NODE_PROPERTY', 'fields', error);
      continue;
    }
    let valid = typeof value === 'boolean';
    if (field.endsWith(':fallbackUserIds')) valid = !issue;
    else if (field.endsWith(':name'))
      valid = typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100;
    if (!allowed.has(field) || !valid) throw new ApiError(422, 'INVALID_NODE_PROPERTY', 'fields', m.invalid);
  }
  // 剔除版本元数据；未编辑配置取最新完整回执，不从最初打开时的版本复制。
  const { id: _id, versionNo: _number, status: _status, publishedAt: _at, ...definition } = structuredClone(version);
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      const values: Record<string, unknown> = { ...node };
      const actions = { ...node.actions };
      for (const field of nodeFields(node, approvalType)) {
        const key = nodeField(node.key, field);
        if (!(key in edited)) {
          if (sourceFields(node).includes(field)) values[field] = nodeValue(node, field);
          continue;
        }
        if (field.startsWith('actions.')) Object.assign(actions, { [field.slice(8)]: edited[key] });
        else if (field === 'routes') values.routes = normalizeRoutes(edited[key] as ExitRoute[]);
        else values[field] = field === 'name' ? (edited[key] as string).trim() : edited[key];
      }
      return { ...values, actions } as unknown as ApprovalNode;
    }),
  };
}
/**
 * 草稿的提交归一化（P2-3 单一入口）：表单值 → 整份草稿（buildDraft：校验、名称去首尾空格、出口规范化）→
 * 请求体（wireDraft：未选人 value:null）。保存的请求体、保存前本地校验、发布前的未保存判定都经它。
 */
export function draftSubmission(version: VersionView, edited: Values, approvalType?: string) {
  const draft = buildDraft(version, edited, approvalType);
  return { draft, body: wireDraft(draft) };
}
/**
 * 发布前“有未保存的修改”：按提交归一化后的请求体与“不改任何字段”的请求体比较。改了又改回、只差保存会去掉的
 * 首尾空格都不算；真实改动算；归一化失败（名称空白等保存会拒的输入）也算，交保存提示，不发布服务端旧草稿。
 */
export function draftChanged(version: VersionView, values: Values, approvalType?: string) {
  const baseline = editableValues(version, approvalType);
  const fields = changedFields(values, baseline, Object.keys(baseline));
  if (!fields.length) return false;
  try {
    const edited = Object.fromEntries(fields.map((field) => [field, values[field]]));
    const unchanged = draftSubmission(version, {}, approvalType).body;
    return !sameValue(draftSubmission(version, edited, approvalType).body, unchanged);
  } catch {
    return true;
  }
}
/**
 * 流程详情按钮的前端入口（P2-4 单一入口）：流程管理能力 + 对象更新操作（catalog 里这些按钮依赖 update）+ 该详情按钮。
 * 后端保存 / 发布 / 新建版本只校验流程管理能力（access.ts requireProcessButton），前端入口是它的子集。
 */
export function buttonAccess(permission: ObjectPermission | undefined, admin: boolean, button: string) {
  return admin && !!permission?.dataOperations.update && canButton(permission, button, 'detail');
}
/** 编辑入口（保存草稿 / 新建版本）：按钮入口之外还要节点可看、可编辑（F-315）。发布不改节点，只看 buttonAccess。 */
export function editAccess(permission: ObjectPermission | undefined, admin: boolean, button: string) {
  return buttonAccess(permission, admin, button) && fieldAccess(permission, 'nodes').editable;
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
