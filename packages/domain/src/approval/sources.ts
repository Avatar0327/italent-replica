/** DEC-686：唯一来源模型；旧表达式仅作为对应来源的命名值，不能单独保存。 */
import { APPROVER_EXPRESSIONS, type ApproverExpression, type ApprovalNode } from './types.js';

export const APPROVER_SOURCE_TYPES = [
  'specified',
  'public_variable',
  'application_variable',
  'object_field',
  'custom_variable',
  'context_variable',
  'department',
  'business_org',
  'profit_center',
  'reserve4',
  'reserve5',
  'position',
  'job',
  'identity',
  'matrix',
] as const;
export type ApproverSourceType = (typeof APPROVER_SOURCE_TYPES)[number];
export interface ApproverSource {
  readonly type: ApproverSourceType;
  readonly value: string;
}
export const EXPRESSION_SOURCE_TYPES: Readonly<Record<ApproverExpression, ApproverSourceType>> = {
  owner: 'custom_variable',
  direct_manager: 'object_field',
  latest_record_department_head: 'department',
  latest_record_department_hrbp: 'department',
  record_department_head: 'department',
  record_department_hrbp: 'department',
  record_first_level_org_head: 'department',
  idp_employee: 'object_field',
  idp_tutor: 'object_field',
  offer_department_head: 'department',
  initiator_direct_manager: 'object_field',
  approval_subject_first_level_org_head: 'department',
  assessment_employee: 'object_field',
  handover_work_owner: 'object_field',
  handover_hr_admin: 'identity',
  handover_employee: 'object_field',
};
/** 预置定义使用同一结构，函数不接收网络输入、不提供字符串兼容路径。 */
export const approverSource = (value: ApproverExpression): ApproverSource => ({
  type: EXPRESSION_SOURCE_TYPES[value],
  value,
});
export const sourceKey = (source: ApproverSource) => `${source.type}:${source.value}`;
export const approverSourcesOf = (node: ApprovalNode): readonly ApproverSource[] =>
  node.kind === 'countersign' ? node.approvers : [node.approver];
export function expressionValue(source: ApproverSource): ApproverExpression | null {
  const value = source.value as ApproverExpression;
  return APPROVER_EXPRESSIONS.includes(value) && EXPRESSION_SOURCE_TYPES[value] === source.type ? value : null;
}
/** DEC-691：引用值沿用唯一 type + value 模型，后缀只在相应来源中有效。 */
export const RELATION_SOURCE_TYPES = [
  'department',
  'business_org',
  'profit_center',
  'reserve4',
  'reserve5',
  'position',
  'job',
] as const;
export type RelationSourceType = (typeof RELATION_SOURCE_TYPES)[number];
export const SOURCE_DIMENSIONS = {
  department: 'admin',
  business_org: 'business',
  profit_center: 'product',
  reserve4: 'reserve4',
  reserve5: 'reserve5',
} as const;
export function relationSource(source: ApproverSource) {
  if (!RELATION_SOURCE_TYPES.includes(source.type as RelationSourceType)) return null;
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::(descendants|relative))?$/.exec(
    source.value,
  );
  if (!match) return null;
  const type = source.type as RelationSourceType;
  const dimension = type in SOURCE_DIMENSIONS ? SOURCE_DIMENSIONS[type as keyof typeof SOURCE_DIMENSIONS] : undefined;
  const mode = match[2] ?? 'self';
  if ((mode === 'descendants' && !dimension) || (mode === 'relative' && type !== 'job')) return null;
  return { type, id: match[1]!, mode, dimension };
}
export function sourceViolation(source: ApproverSource): string | null {
  if (['public_variable', 'application_variable', 'matrix'].includes(source.type)) return '暂不支持，后补 F-326';
  if (expressionValue(source)) return null;
  if (relationSource(source)) return null;
  if (source.type === 'identity') return '该来源待 F-318c 开放（身份 c2）';
  if (
    source.type === 'specified' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(source.value)
  )
    return null;
  if (source.type === 'object_field' && source.value === 'business_record_direct_manager') return null;
  if (source.type === 'context_variable' && source.value === 'previous_approved') return null;
  return '审批人来源的值不合法';
}

/** 会签按有效账号去重；先确定候选集合再抽样，随机函数由运行端注入可复现实现。 */
export function sampleApprovers<T>(items: readonly T[], key: (item: T) => string | null, random: () => number): T[] {
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    const id = key(item);
    if (id === null) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const present = unique.filter((item) => key(item) !== null);
  if (present.length <= 100) return unique;
  for (let i = present.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [present[i], present[j]] = [present[j]!, present[i]!];
  }
  return [...present.slice(0, 100), ...unique.filter((item) => key(item) === null)];
}
