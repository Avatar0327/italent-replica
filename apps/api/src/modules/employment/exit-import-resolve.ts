/**
 * F-493 历史离职人员导入：执行器里读库的行判定（设计 §3.3 第 2～4 步）。
 * 引用 / 字典按名称或编码解析为稳定对象（DEC-060）；日期区间按租户时区的“今天”判；Z 列没有对应字段一律拒绝。
 * 前一步有错的行不进下一步（同一步内的错误一起收齐）。
 */
import { sql, type Tx } from '@italent/db';
import { exitImportEffectiveDate, type ExitDictionaryKind } from '@italent/domain';
import { rowsOf } from './record-store.js';
import { isoOf, type ImportRowInput, type RowError } from './exit-import-shape.js';

export interface ResolvedImportRow {
  readonly departmentId: string;
  readonly positionId: string | null;
  readonly postId: string | null;
  readonly levelId: string | null;
  readonly exitTypeCode: string | null;
  readonly reasonCode: string | null;
  readonly whereaboutsCode: string | null;
  readonly entryDate: string;
  readonly lastWorkDate: string;
  /** 离职生效日 E = L + 1。 */
  readonly effectiveDate: string;
}

type Found = { readonly id: string } | { readonly error: 'REFERENCE_NOT_FOUND' | 'REFERENCE_AMBIGUOUS' };
const pick = (ids: readonly string[]): Found =>
  ids.length === 0
    ? { error: 'REFERENCE_NOT_FOUND' }
    : ids.length > 1
      ? { error: 'REFERENCE_AMBIGUOUS' }
      : { id: ids[0]! };

/** 部门编码 → 组织稳定 ID：同一编码历史上挂过多个组织时按歧义报，不猜。 */
async function findDepartment(tx: Tx, tenantId: string, code: string): Promise<Found> {
  const found = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT DISTINCT org_id::text AS id FROM org_versions
      WHERE tenant_id=${tenantId} AND code=${code} LIMIT 2`),
  );
  return pick(found.map((r) => r.id));
}

/** 职务体系对象按名称匹配：只认入职日当天启用且在有效期内的版本，同名多个对象即歧义（设计 §3.3）。 */
async function findJob(
  tx: Tx,
  tenantId: string,
  table: 'job_position_versions' | 'job_post_versions' | 'job_level_versions',
  name: string,
  on: string,
  orgId?: string,
): Promise<Found> {
  const found = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT DISTINCT object_id::text AS id FROM ${sql.identifier(table)}
      WHERE tenant_id=${tenantId} AND name=${name} AND enabled
        AND start_date <= ${on}::date AND ${on}::date <= stop_date
        ${orgId ? sql`AND org_id=${orgId}::uuid` : sql``} LIMIT 2`),
  );
  return pick(found.map((r) => r.id));
}

const DICTIONARY_TABLE: Record<ExitDictionaryKind, string> = {
  types: 'exit_types',
  reasons: 'exit_reasons',
  whereabouts: 'exit_whereabouts',
};

/** 离职字典按名称精确匹配；停用项单独报 DISABLED（名称在租户内不要求唯一）。 */
async function findDictionary(
  tx: Tx,
  tenantId: string,
  kind: ExitDictionaryKind,
  name: string,
): Promise<{ code: string } | { error: 'REFERENCE_NOT_FOUND' | 'REFERENCE_AMBIGUOUS' | 'REFERENCE_DISABLED' }> {
  const found = rowsOf<{ code: string; enabled: boolean }>(
    await tx.execute(sql`SELECT code, enabled FROM ${sql.identifier(DICTIONARY_TABLE[kind])}
      WHERE tenant_id=${tenantId} AND name=${name} LIMIT 3`),
  );
  if (found.length === 0) return { error: 'REFERENCE_NOT_FOUND' };
  const enabled = found.filter((item) => item.enabled);
  if (enabled.length > 1) return { error: 'REFERENCE_AMBIGUOUS' };
  if (enabled.length === 0) return { error: 'REFERENCE_DISABLED' };
  return { code: enabled[0]!.code };
}

export type RowVerdict =
  { readonly errors: readonly RowError[] } | { readonly errors: readonly []; readonly resolved: ResolvedImportRow };

/** 第 2～4 步：引用与字典 → 日期区间 → 没有对应字段的列；返回的 errors 非空即整行失败、零写入。 */
export async function resolveImportRow(
  tx: Tx,
  tenantId: string,
  row: ImportRowInput,
  today: string,
): Promise<RowVerdict> {
  const entryDate = isoOf(row.entryDate)!;
  const lastWorkDate = isoOf(row.lastWorkDate)!;
  const errors: RowError[] = [];
  const fail = (column: string, reason: RowError['reason']) => errors.push({ column, reason });

  const department = await findDepartment(tx, tenantId, row.departmentCode!);
  if ('error' in department) fail('D', department.error);
  const deptId = 'id' in department ? department.id : undefined;
  const lookups: [string, string | null, () => Promise<Found>][] = [
    ['F', row.positionName, () => findJob(tx, tenantId, 'job_position_versions', row.positionName!, entryDate, deptId)],
    ['G', row.postName, () => findJob(tx, tenantId, 'job_post_versions', row.postName!, entryDate)],
    ['H', row.levelName, () => findJob(tx, tenantId, 'job_level_versions', row.levelName!, entryDate)],
  ];
  const ids: Record<string, string | null> = { F: null, G: null, H: null };
  for (const [column, value, find] of lookups) {
    // 职位挂在部门下：部门没解析出来时不判职位，免得把部门的错误重复算在 F 列上
    if (value === null || (column === 'F' && !deptId)) continue;
    const result = await find();
    if ('error' in result) fail(column, result.error);
    else ids[column] = result.id;
  }
  const dictionaries: [string, ExitDictionaryKind, string | null][] = [
    ['W', 'types', row.exitTypeName],
    ['X', 'reasons', row.exitReasonName],
    ['Y', 'whereabouts', row.whereaboutsName],
  ];
  const codes: Record<string, string | null> = { W: null, X: null, Y: null };
  for (const [column, kind, value] of dictionaries) {
    if (value === null) continue;
    const result = await findDictionary(tx, tenantId, kind, value);
    if ('error' in result) fail(column, result.error);
    else codes[column] = result.code;
  }
  if (errors.length) return { errors };

  // 区间：入职日不得早于部门最早版本；H ≤ L；L 必须早于租户时区的今天（部门停用状态不判，DEC-839③）
  const [first] = rowsOf<{ founded: string }>(
    await tx.execute(sql`SELECT start_date::text AS founded FROM org_versions
      WHERE tenant_id=${tenantId} AND org_id=${deptId}::uuid ORDER BY start_date, version_no LIMIT 1`),
  );
  if (first && entryDate < first.founded) fail('E', 'DEPARTMENT_NOT_FOUNDED');
  if (entryDate > lastWorkDate) fail('V', 'RANGE_INVERTED');
  else if (lastWorkDate >= today) fail('V', 'NOT_HISTORICAL');
  if (errors.length) return { errors };

  if (row.exitNote !== null) return { errors: [{ column: 'Z', reason: 'NOT_SUPPORTED' }] };
  return {
    errors: [],
    resolved: {
      departmentId: deptId!,
      positionId: ids.F!,
      postId: ids.G!,
      levelId: ids.H!,
      exitTypeCode: codes.W!,
      reasonCode: codes.X!,
      whereaboutsCode: codes.Y!,
      entryDate,
      lastWorkDate,
      effectiveDate: exitImportEffectiveDate(lastWorkDate),
    },
  };
}
