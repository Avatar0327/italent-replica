import {
  APPROVAL_TYPES,
  APPROVER_EXPRESSIONS,
  APPROVER_SOURCE_TYPES,
  approverSource,
  approverSourceViolations,
  identityProfileId,
  matrixSourceParts,
  relationSource,
  RELATION_SOURCE_TYPES,
  sourceKey,
  isUnselectedSpecified,
  sourceViolation,
  type ApprovalNode,
  type ApproverSource,
  type ApproverSourceType,
} from '@italent/domain';
import { m } from './messages.js';
import { s } from './source-messages.js';

type Status = 'enabled' | 'restricted';
export type SourceOption = { value: string; label: string; disabled: boolean; status: Status };
const VARIABLE_SOURCE_TYPES: readonly ApproverSourceType[] = ['public_variable', 'application_variable'];
/**
 * DEC-691 / F-326 §5.4：组织 / 职位 / 职务 / 身份 / 变量的取值是候选接口里的对象 ID（组织类可带后缀），
 * 类型与值都交领域校验判断；矩阵取值是“矩阵:角色列”，走两级选择（MatrixValue）。
 */
export const REFERENCE_SOURCE_TYPES: readonly ApproverSourceType[] = [
  ...RELATION_SOURCE_TYPES,
  'identity',
  ...VARIABLE_SOURCE_TYPES,
];
const CANDIDATE_SOURCE_TYPES: readonly ApproverSourceType[] = [...REFERENCE_SOURCE_TYPES, 'matrix'];
const PROBE = '00000000-0000-0000-0000-000000000000';
const probe = (type: ApproverSourceType): ApproverSource => ({
  type,
  value: type === 'matrix' ? `${PROBE}:${PROBE}` : PROBE,
});
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
    const enabled =
      type === 'specified' || CANDIDATE_SOURCE_TYPES.includes(type)
        ? // 只探测来源类型能力，不查询或提交此占位 ID；与实际选择后的领域校验同源（DEC-697）。
          sourceAllowed(probe(type), node, approvalType) || children.some((option) => !option.disabled)
        : children.some((option) => !option.disabled);
    const status: Status = enabled ? 'enabled' : 'restricted';
    const suffix = enabled ? '' : ` · ${s.restricted}`;
    return { value: type, label: s.types[type] + suffix, disabled: status !== 'enabled', status, children };
  });
}
export function sourceInputError(value: unknown, node: ApprovalNode, approvalType?: string, empty = false) {
  const multiple = empty || node.kind === 'countersign';
  if (!(multiple ? sourcesShape(value) : sourceShape(value))) return s.invalid;
  const sources = (multiple ? value : [value]) as ApproverSource[];
  if (!empty && sources.length === 0) return s.required;
  if (sources.length > 200) return s.limit;
  // 未选人占位（S7b）不参与查重：会签可以留多行待选，保存时后端合成一个自动变量
  const chosen = sources.filter((source) => !isUnselectedSpecified(source));
  if (new Set(chosen.map(sourceKey)).size !== chosen.length) return s.duplicate;
  const options = sourceOptions(node, approvalType);
  for (const source of sources) {
    const option = options.find((item) => item.value === source.type);
    if (!option || option.disabled) return option ? option.label : s.invalid;
    const fixedValue = option.children.some((item) => item.value === source.value && !item.disabled);
    const dynamic = source.type === 'specified' || CANDIDATE_SOURCE_TYPES.includes(source.type);
    if (!fixedValue && !(dynamic && sourceAllowed(source, node, approvalType))) return s.invalid;
  }
  return undefined;
}
/** 引用值拆成对象 ID 与取值方式；身份与变量只有对象 ID。固定表达式（如部门负责人）不是引用，返回 null。 */
export function referenceOf(source: ApproverSource) {
  const relation = relationSource(source);
  if (relation) return { id: relation.id, mode: relation.mode };
  const variable = VARIABLE_SOURCE_TYPES.includes(source.type) && !sourceViolation(source) ? source.value : null;
  const id = identityProfileId(source) ?? variable;
  return id ? { id, mode: 'self' } : null;
}
/** 矩阵取值拆成矩阵 ID 与候选接口的角色列 ID（`矩阵:角色列`，设计 §5.3）；格式不对返回 null。 */
export function matrixReference(source: ApproverSource) {
  const parts = matrixSourceParts(source);
  return parts ? { matrixId: parts.matrixId, columnKey: source.value } : null;
}
export const referenceValue = (id: string, mode: string) => (mode === 'self' ? id : `${id}:${mode}`);
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
          ? isUnselectedSpecified(source)
            ? s.unselected
            : (names.get(source.value) ?? s.personUnavailable)
          : `${s.types[source.type]} → ${sourceValueLabel(source.value)}`,
      )
      .join('、') ?? s.unknown
  );
}
