/**
 * F-326 §3.2/§3.3：变量与矩阵来源的取人。读的是节点激活当下的最新值，已派任务不受后续改值影响（AC-APV-F326-13）。
 * 变量或矩阵停用 / 角色列被删，一律按“没有人”交给节点的审批人为空策略，不抛错也不借别处兜底。
 */
import { sql, type Tx } from '@italent/db';
import { matrixSourceParts, type ApproverSource, type Candidate, type VariableDataType } from '@italent/domain';
import { rowsOf } from './context.js';
import { loadMatrixStructure, type MatrixColumn, type MatrixRow } from './matrix-structure.js';
import { resolveFallbackCandidates, type RoutingSubject } from './resolver.js';
import { ancestors, orgGraph, subjectPrimaryJob } from './source-relations.js';
import { variablePersonIds } from './variable-input.js';

export async function resolveVariable(tx: Tx, subject: RoutingSubject, source: ApproverSource): Promise<Candidate[]> {
  const [row] = rowsOf<{
    status: string;
    scope: string;
    usage_scopes: string[];
    data_type: string;
    value: string | null;
  }>(
    await tx.execute(sql`SELECT status, scope, usage_scopes, data_type, default_value::text AS value
      FROM approval_variables WHERE tenant_id=${subject.tenantId}::uuid AND id=${source.value}::uuid`),
  );
  if (!row || row.status !== 'enabled') return [];
  // 设计 §3.5：公共变量移出“流程”适用范围后，已发布流程运行时按“没有人”走空人策略（应用变量没有适用范围）
  if (row.scope === 'public' && !row.usage_scopes.includes('process')) return [];
  const defaultValue = row.value === null ? null : JSON.parse(row.value);
  return resolveFallbackCandidates(
    tx,
    subject,
    variablePersonIds({ dataType: row.data_type as VariableDataType, defaultValue }),
  );
}

/** 部门条件列的取值：申请对象在业务日的任职部门；含下级时展开成它的行政祖先链（含自身）。 */
async function departmentValues(tx: Tx, subject: RoutingSubject, includeChildren: boolean): Promise<string[]> {
  const departmentId = subject.recordDepartmentId ?? subject.latestDepartmentId;
  if (!departmentId) return [];
  if (!includeChildren || !subject.businessDate) return [departmentId];
  const graph = new Map((await orgGraph(tx, subject, departmentId, 'admin', false)).map((node) => [node.id, node]));
  const chain = [departmentId];
  // 生成器的返回值只说明链为何终止（根 / 断链 / 环），矩阵匹配不关心
  for (const node of ancestors(graph, departmentId, subject.tenantId)) chain.push(node.id);
  return [...new Set(chain)];
}

async function conditionValues(tx: Tx, subject: RoutingSubject, column: MatrixColumn): Promise<string[]> {
  if (column.dimension === 'department') return departmentValues(tx, subject, column.includeChildren);
  if (column.dimension !== 'position' && column.dimension !== 'job') return [];
  const value = await subjectPrimaryJob(tx, subject, column.dimension);
  return value ? [value] : [];
}

/** 空单元格不限制；非空单元格要求取值命中，取值为空（没有部门 / 主职）即不命中。 */
const hits = (cell: readonly string[], values: readonly string[]) =>
  !cell.length || values.some((value) => cell.includes(value));

export async function resolveMatrix(tx: Tx, subject: RoutingSubject, source: ApproverSource): Promise<Candidate[]> {
  const parts = matrixSourceParts(source);
  if (!parts) return [];
  // 表头取共享锁并持到事务结束：与管理员整体保存 / 停用（FOR UPDATE）串行，状态、列、行、单元格来自同一份结构
  // （矩阵详情入口同口径）；否则交错时会读到新行的单元格而旧行表里没有它，推进抛 TypeError
  const [head] = rowsOf<{ status: string }>(
    await tx.execute(sql`SELECT status FROM approval_matrices
      WHERE tenant_id=${subject.tenantId}::uuid AND id=${parts.matrixId}::uuid FOR SHARE`),
  );
  if (head?.status !== 'enabled') return [];
  const { columns, rows } = await loadMatrixStructure(tx, subject.tenantId, parts.matrixId);
  if (!columns.some((column) => column.id === parts.columnId && column.kind === 'role')) return [];
  const conditions = columns.filter((column) => column.kind === 'condition');
  const values = new Map<string, string[]>();
  for (const column of conditions)
    if (rows.some((row: MatrixRow) => row.cells[column.id]?.length))
      values.set(column.id, await conditionValues(tx, subject, column));
  // rows 已按 seq 排序：第一条命中的行决定结果，角色格为空也不再往后找
  const matched = rows.find((row) =>
    conditions.every((column) => hits(row.cells[column.id] ?? [], values.get(column.id) ?? [])),
  );
  return matched ? resolveFallbackCandidates(tx, subject, matched.cells[parts.columnId] ?? []) : [];
}
