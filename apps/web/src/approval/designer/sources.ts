import {
  APPROVAL_TYPES,
  APPROVER_EXPRESSIONS,
  APPROVER_SOURCE_TYPES,
  approverSource,
  approverSourceViolations,
  sourceKey,
  type ApprovalNode,
  type ApproverSource,
  type ApproverSourceType,
} from '@italent/domain';
import { m } from './messages.js';
import { s } from './source-messages.js';

type Status = 'enabled' | 'unsupported' | 'pending' | 'restricted';
export type SourceOption = { value: string; label: string; disabled: boolean; status: Status };
const unsupported = new Set<ApproverSourceType>(['public_variable', 'application_variable', 'matrix']);
// DEC-686：F-318c 合入后从此入口扩展新值与候选适配；现有固定表达式仍走领域校验。
const pending = new Set<ApproverSourceType>([
  'department',
  'business_org',
  'profit_center',
  'reserve4',
  'reserve5',
  'position',
  'job',
  'identity',
]);
const fixed: ApproverSource[] = [
  ...APPROVER_EXPRESSIONS.map(approverSource),
  { type: 'object_field', value: 'business_record_direct_manager' },
  { type: 'context_variable', value: 'previous_approved' },
];
export const sourceValueLabel = (value: string) => s.values[value] ?? m.expressions[value] ?? s.unknown;
export const sourceShape = (value: unknown): value is ApproverSource => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as ApproverSource;
  return APPROVER_SOURCE_TYPES.includes(source.type) && typeof source.value === 'string';
};
export const sourcesShape = (value: unknown): value is ApproverSource[] =>
  Array.isArray(value) && value.every(sourceShape);
export function sourceList(value: unknown): ApproverSource[] | undefined {
  if (sourcesShape(value)) return value;
  if (sourceShape(value)) return [value];
  return undefined;
}
export function changeSourceType(_source: ApproverSource, type: ApproverSourceType): ApproverSource {
  return { type, value: '' };
}
function sourceAllowed(source: ApproverSource, node: ApprovalNode, approvalType?: string) {
  const type = APPROVAL_TYPES[approvalType as keyof typeof APPROVAL_TYPES];
  if (!type) return false;
  return (
    approverSourceViolations(
      {
        ...node,
        kind: 'single',
        approver: source,
        emptyApproverSources: [],
        emptyApproverPolicy: undefined,
      },
      type,
    ).length === 0
  );
}
/** 类型、值与提交校验共用此表；不另抄 HANDOVER_ONLY / OFFER_ONLY 等规则。 */
export function sourceOptions(node: ApprovalNode, approvalType?: string) {
  return APPROVER_SOURCE_TYPES.map((type) => {
    const children: SourceOption[] = fixed
      .filter((source) => source.type === type)
      .map((source) => {
        const allowed = sourceAllowed(source, node, approvalType);
        return {
          value: source.value,
          label: sourceValueLabel(source.value),
          disabled: !allowed,
          status: allowed ? 'enabled' : 'restricted',
        };
      });
    if (pending.has(type)) children.push({ value: '$pending', label: s.newValue, disabled: true, status: 'pending' });
    const enabled =
      type === 'specified'
        ? !!APPROVAL_TYPES[approvalType as keyof typeof APPROVAL_TYPES]
        : children.some((option) => !option.disabled);
    let status: Status = 'restricted';
    if (unsupported.has(type)) status = 'unsupported';
    else if (enabled) status = 'enabled';
    else if (pending.has(type)) status = 'pending';
    const suffix = status === 'enabled' ? '' : ` · ${s[status]}`;
    return { value: type, label: s.types[type] + suffix, disabled: status !== 'enabled', status, children };
  });
}
export function sourceInputError(value: unknown, node: ApprovalNode, approvalType?: string, empty = false) {
  const multiple = empty || node.kind === 'countersign';
  if (!(multiple ? sourcesShape(value) : sourceShape(value))) return s.invalid;
  const sources = (multiple ? value : [value]) as ApproverSource[];
  if (!empty && sources.length === 0) return s.required;
  if (sources.length > 200) return s.limit;
  if (new Set(sources.map(sourceKey)).size !== sources.length) return s.duplicate;
  const options = sourceOptions(node, approvalType);
  for (const source of sources) {
    const option = options.find((item) => item.value === source.type);
    if (!option || option.disabled) return option ? option.label : s.invalid;
    if (source.type === 'specified') {
      if (!sourceAllowed(source, node, approvalType)) return s.invalid;
    } else if (!option.children.some((item) => item.value === source.value && !item.disabled)) return s.invalid;
  }
  return undefined;
}
export const sourceFields = (node: ApprovalNode) => [
  node.kind === 'countersign' ? 'approvers' : 'approver',
  ...(node.emptyApproverPolicy === 'specified' ? ['emptyApproverSources'] : []),
];
/** 冲突与未知回查只展示可读摘要，不能把账号 UUID 通过通用 JSON 表格泄露。 */
export function sourceSummary(value: unknown, names: ReadonlyMap<string, string> = new Map()): unknown {
  const sources = sourceList(value);
  return (
    sources
      ?.map((source) =>
        source.type === 'specified'
          ? (names.get(source.value) ?? s.personUnavailable)
          : `${s.types[source.type]} → ${sourceValueLabel(source.value)}`,
      )
      .join('、') ?? s.unknown
  );
}
