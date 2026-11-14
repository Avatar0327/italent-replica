/**
 * F-326 §3.7 模拟的“当前值路径”：只在流程管理员显式带 `resolveCurrentSources` 时才读变量 / 矩阵当前值。
 * 做法是在推演前把没给虚拟值的三类来源解析成虚拟 `sourceRelations`，其余推演逻辑原样不动；只读，不落库。
 * 矩阵条件仍取虚拟输入（`data.values` / `data.orgAncestors`），不读真实组织与任职。
 */
import type { Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  approverSourcesOf,
  type ConditionField,
  sourceKey,
  tenantLocalDate,
  type ApprovalTypeCode,
  type ApproverSource,
  type Candidate,
} from '@italent/domain';
import type { ApprovalContext } from './context.js';
import type { VersionView } from './definitions.js';
import type { MatrixColumn } from './matrix-structure.js';
import type { RoutingSubject } from './resolver.js';
import { resolveMatrixWith, resolveVariable } from './source-matrix.js';
import type { SimulationData } from './simulation.js';

const CURRENT_TYPES: readonly string[] = ['public_variable', 'application_variable', 'matrix'];

/**
 * 矩阵条件列的三个虚拟维度输入路径（设计 §2.1 / §3.7）：部门、职位、职务不依赖审批类型自带的发起条件字段，
 * 否则 part_time_add / personnel_change 等没有职位 / 职务条件字段的类型，传值 400、不传则该维度恒为空。
 * 只作模拟输入，仍不读真实任职；类型自己已定义同名路径时以类型定义为准（`simulationFieldsOf` 里类型字段在前，使用方按“先出现者优先”取）。
 */
export const MATRIX_VIRTUAL_FIELDS: readonly ConditionField[] = [
  { path: 'record.departmentId', label: '矩阵条件 - 部门', kind: 'org' },
  { path: 'record.positionId', label: '矩阵条件 - 职位', kind: 'reference' },
  { path: 'record.postId', label: '矩阵条件 - 职务', kind: 'reference' },
];

/** 模拟输入可用的条件字段：类型自带字段在前，矩阵虚拟维度补在后（同路径先出现者优先）。 */
export const simulationFieldsOf = (type: ApprovalTypeCode): readonly ConditionField[] => [
  ...APPROVAL_TYPES[type].conditionFields,
  ...MATRIX_VIRTUAL_FIELDS,
];

/** 虚拟主体：没有真实员工与部门，只让停用账号 / 离职人员过滤按“今天”判断（与运行时同一过滤）。 */
const virtualSubject = (ctx: ApprovalContext): RoutingSubject => ({
  tenantId: ctx.tenantId,
  asOf: tenantLocalDate(ctx.now, ctx.timezone),
  initiatorUserId: ctx.userId,
  subjectEmployeeId: null,
  latestDepartmentId: null,
  recordDepartmentId: null,
  cache: new Map(),
});

/** 条件列的虚拟取值：部门取本类型的“本条记录部门”（缺省取第一个有值的组织字段），职位 / 职务取本条记录的值。 */
function virtualValues(type: ApprovalTypeCode, data: SimulationData) {
  const orgPaths = simulationFieldsOf(type)
    .filter((field) => field.kind === 'org')
    .map((f) => f.path);
  const departmentPath = ['record.departmentId', ...orgPaths].find((path) => data.values[path]);
  const department = departmentPath ? data.values[departmentPath]! : null;
  return (column: MatrixColumn): string[] => {
    if (column.dimension === 'position' || column.dimension === 'job') {
      const value = data.values[column.dimension === 'position' ? 'record.positionId' : 'record.postId'];
      return value ? [value] : [];
    }
    if (column.dimension !== 'department' || !department) return [];
    return column.includeChildren ? [...(data.orgAncestors?.[department] ?? [department])] : [department];
  };
}

async function currentUsers(
  tx: Tx,
  subject: RoutingSubject,
  source: ApproverSource,
  type: ApprovalTypeCode,
  data: SimulationData,
): Promise<readonly string[]> {
  const found: Candidate[] =
    source.type === 'matrix'
      ? await resolveMatrixWith(tx, subject, source, async (column) => virtualValues(type, data)(column))
      : await resolveVariable(tx, subject, source);
  return found.flatMap((candidate) => candidate.userId ?? []);
}

/** 返回补上当前值的模拟输入；调用方给过的虚拟值（含空数组）优先，不被覆盖。 */
export async function withCurrentSources(
  tx: Tx,
  ctx: ApprovalContext,
  version: VersionView,
  type: ApprovalTypeCode,
  data: SimulationData,
): Promise<SimulationData> {
  const subject = virtualSubject(ctx);
  const current: Record<string, readonly string[]> = {};
  for (const node of version.nodes) {
    for (const source of [...approverSourcesOf(node), ...(node.emptyApproverSources ?? [])]) {
      const key = sourceKey(source);
      if (!CURRENT_TYPES.includes(source.type) || data.sourceRelations?.[key] || key in current) continue;
      current[key] = await currentUsers(tx, subject, source, type, data);
    }
  }
  return { ...data, sourceRelations: { ...current, ...data.sourceRelations } };
}
