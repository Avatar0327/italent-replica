// F-326 S7b（主设计 §5.5 ④⑦、F-326-L §5.5）：读视图把本流程本位置的自动变量标成 public_variable + autoVariable
// （apps/api enrichProcessView）。设计器里它回显为“指定人员”，保存时按指定人员提交，由后端更新 / 记待生效 / 重建变量；
// 其他流程的自动变量不带 autoVariable，照普通公共变量显示。
import {
  isUnselectedSpecified,
  UNSELECTED_SPECIFIED,
  type ApprovalNode,
  type ApproverSource,
  type ProcessDefinition,
} from '@italent/domain';
import type { AutoVariableView } from '../../../../api/src/modules/approval/auto-variables.js';

export type { AutoVariableView };
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function autoVariableOf(source: unknown): AutoVariableView | undefined {
  if (!object(source) || source.type !== 'public_variable' || !object(source.autoVariable)) return undefined;
  const auto = source.autoVariable;
  const valid =
    ['id', 'code', 'status'].every((key) => typeof auto[key] === 'string') &&
    (auto.userIds === null || ids(auto.userIds)) &&
    (auto.pendingUserIds === undefined || ids(auto.pendingUserIds)) &&
    typeof auto.referencingProcessCount === 'number';
  return valid ? (auto as unknown as AutoVariableView) : undefined;
}

/** 设计器显示与提交的人员：有待生效值取待生效值（发布后生效），否则取变量当前默认值。 */
export const autoPeople = (auto: AutoVariableView) => auto.pendingUserIds ?? auto.userIds ?? [];

/** 多来源位置（会签、审批人为空）：自动变量展开为逐人一行；没有人员时留一行未选人占位。 */
export const echoSources = (sources: readonly ApproverSource[]): ApproverSource[] =>
  sources.flatMap((source) => {
    const auto = autoVariableOf(source);
    if (!auto) return [source];
    const people = autoPeople(auto);
    return people.length
      ? people.map((value) => ({ type: 'specified' as const, value }))
      : [{ ...UNSELECTED_SPECIFIED }];
  });
/** 单人节点：取第一人，没有人员时是未选人占位。 */
export function echoSource(source: ApproverSource): ApproverSource {
  const auto = autoVariableOf(source);
  return auto ? { type: 'specified', value: autoPeople(auto)[0] ?? '' } : source;
}
/** 一个位置的全部指定来源合成一个变量（后端 materializeSlot），取第一条带 autoVariable 的即可。 */
export const slotAutoVariable = (sources: readonly ApproverSource[] | undefined) =>
  (sources ?? []).map(autoVariableOf).find((auto) => auto !== undefined);

// 未选人占位在表单与定位里是 value ''（与 domain isUnselectedSpecified 一致）；接口只认 value:null（S7a 输入契约）。
const wire = (source: ApproverSource) => (isUnselectedSpecified(source) ? { type: 'specified', value: null } : source);
export function wireDraft(definition: ProcessDefinition): ProcessDefinition {
  const nodes = definition.nodes.map((node) => {
    const values: Record<string, unknown> = { ...node };
    for (const field of ['approver', 'approvers', 'emptyApproverSources'] as const) {
      const value = values[field] as ApproverSource | ApproverSource[] | undefined;
      if (value) values[field] = Array.isArray(value) ? value.map(wire) : wire(value);
    }
    return values as unknown as ApprovalNode;
  });
  return { ...definition, nodes };
}
