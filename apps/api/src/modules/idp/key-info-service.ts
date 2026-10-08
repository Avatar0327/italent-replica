/**
 * 关键信息维护：带教 / 职业发展 / 轮岗（docs/02_业务建模/28 IDP-R19～R22；PR 描述 K-35）。
 * - 判重键：带教 = 带教人 + 被带教人 + 起止；职业发展 = 员工 + 起止；轮岗 = 员工 + 部门 + 职位 + 起止（🟡 加员工）；
 * - 员工须在操作人 IDP 范围内（带教双方都须在范围内，范围外 404），轮岗部门须在范围内（管理单元限制，IDP-R21）；
 *   范围谓词见 key-info-scope.ts（读取、列表、计划详情聚合与审计共用）；
 * - 写入与审计同事务，审计按员工（带教按被带教人）归属。
 */
import { pgErrorCode, sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { type ModuleScope, rowsOf } from './access.js';
import { keyInfoScopeSql, type KeyInfoSpec } from './key-info-scope.js';
import { audit, conflict, created, requireRevision, type WriteContext } from './write-support.js';

export { KEY_INFO, type KeyInfoKind, type KeyInfoSpec } from './key-info-scope.js';

const UUID_COLUMNS = /_id$/;
const cast = (column: string) =>
  column.endsWith('_date') ? sql`::date` : UUID_COLUMNS.test(column) ? sql`::uuid` : sql``;

function selectList(spec: KeyInfoSpec) {
  const fields = Object.entries(spec.columns).map(([field, column]) =>
    column.endsWith('_date') ? sql.raw(`${column}::text AS "${field}"`) : sql.raw(`${column} AS "${field}"`),
  );
  return sql.join([sql.raw('id, revision, created_by AS "createdBy"'), ...fields], sql`, `);
}

export type KeyInfoRow = Record<string, unknown> & { id: string; revision: number; createdBy: string };

export async function loadKeyInfo(tx: Tx, tenantId: string, spec: KeyInfoSpec, id: string, lock = false) {
  const [row] = rowsOf<KeyInfoRow>(
    await tx.execute(sql`SELECT ${selectList(spec)} FROM ${sql.raw(spec.table)}
      WHERE tenant_id = ${tenantId} AND id = ${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}`),
  );
  return row ? { ...row, revision: Number(row.revision) } : undefined;
}

/** 记录涉及的员工 / 部门都在范围内（范围外与不存在同为 404）。 */
export async function inScope(tx: Tx, scope: ModuleScope, spec: KeyInfoSpec, row: Record<string, unknown>) {
  const value = (field: string) => sql`${(row[field] as string | null | undefined) ?? null}::uuid`;
  const [hit] = rowsOf<{ visible: boolean }>(
    await tx.execute(sql`SELECT ${keyInfoScopeSql(scope, spec, value)} AS visible`),
  );
  return hit?.visible === true;
}

/** 列表：记录涉及的员工（带教双方）与轮岗部门都在范围内（分页之前）。 */
export async function listKeyInfo(
  tx: Tx,
  tenantId: string,
  spec: KeyInfoSpec,
  visible: SQL,
  page: { limit: number; offset: number },
  employeeId?: string,
) {
  const anchor = sql.raw(spec.columns[spec.persons[0]!]!);
  return rowsOf<KeyInfoRow>(
    await tx.execute(sql`SELECT ${selectList(spec)} FROM ${sql.raw(spec.table)}
      WHERE tenant_id = ${tenantId} AND ${visible}
        ${employeeId ? sql`AND ${anchor} = ${employeeId}::uuid` : sql``}
      ORDER BY start_date, id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
}

async function requireInScope(tx: Tx, ctx: WriteContext, spec: KeyInfoSpec, row: Record<string, unknown>) {
  if (!(await inScope(tx, ctx.scope, spec, row))) throw new AppError('NOT_FOUND', `${spec.label}不存在`);
}

/** 唯一约束 → 判重冲突；外键 → 引用对象不存在。 */
async function guarded<T>(spec: KeyInfoSpec, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const code = pgErrorCode(error);
    if (code === '23505') conflict(spec.duplicate, `${spec.label}已存在（判重键相同）`);
    if (code === '23503') throw new AppError('NOT_FOUND', '引用的员工、组织或职位不存在');
    if (code === '23514') throw new AppError('VALIDATION_FAILED', `${spec.label}的起止时间或人员不合法`);
    throw error;
  }
}

const auditAnchor = (spec: KeyInfoSpec, row: Record<string, unknown>) => row[spec.persons[0]!] as string;

export async function createKeyInfo(tx: Tx, ctx: WriteContext, spec: KeyInfoSpec, input: Record<string, unknown>) {
  await requireInScope(tx, ctx, spec, input);
  const entries = Object.entries(spec.columns).filter(([field]) => input[field] !== undefined);
  const columns = sql.join(
    entries.map(([, column]) => sql.raw(column)),
    sql`, `,
  );
  const values = sql.join(
    entries.map(([field, column]) => sql`${input[field] ?? null}${cast(column)}`),
    sql`, `,
  );
  const meta = created(ctx);
  const [row] = await guarded(spec, async () =>
    rowsOf<{ id: string }>(
      await tx.execute(sql`INSERT INTO ${sql.raw(spec.table)}
        (tenant_id, ${columns}, created_by, created_at, updated_at)
        VALUES (${ctx.tenantId}, ${values}, ${meta.createdBy}::uuid, ${ctx.now.toISOString()},
          ${ctx.now.toISOString()}) RETURNING id`),
    ),
  );
  const after = (await loadKeyInfo(tx, ctx.tenantId, spec, row!.id))!;
  await audit(tx, ctx, spec.object, 'create', after.id, { before: null, after, employeeId: auditAnchor(spec, after) });
  return after;
}

export async function updateKeyInfo(
  tx: Tx,
  ctx: WriteContext,
  spec: KeyInfoSpec,
  id: string,
  patch: Record<string, unknown>,
) {
  const before = await loadKeyInfo(tx, ctx.tenantId, spec, id, true);
  if (!before) throw new AppError('NOT_FOUND', `${spec.label}不存在`);
  await requireInScope(tx, ctx, spec, before);
  requireRevision(ctx, before.revision, spec.label);
  const merged: Record<string, unknown> = { ...before, ...patch };
  await requireInScope(tx, ctx, spec, merged);
  if (merged.endDate && (merged.endDate as string) < (merged.startDate as string)) {
    throw new AppError('VALIDATION_FAILED', '结束时间不能早于开始时间');
  }
  const sets = Object.entries(spec.columns)
    .filter(([field]) => patch[field] !== undefined)
    .map(([field, column]) => sql`${sql.raw(column)} = ${patch[field] ?? null}${cast(column)}`);
  await guarded(spec, () =>
    tx.execute(
      sql`UPDATE ${sql.raw(spec.table)} SET ${sql.join(
        [...sets, sql`revision = revision + 1`, sql`updated_at = ${ctx.now.toISOString()}`],
        sql`, `,
      )} WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`,
    ),
  );
  const after = (await loadKeyInfo(tx, ctx.tenantId, spec, id))!;
  await audit(tx, ctx, spec.object, 'update', id, { before, after, employeeId: auditAnchor(spec, after) });
  return after;
}

export async function deleteKeyInfo(tx: Tx, ctx: WriteContext, spec: KeyInfoSpec, id: string) {
  const before = await loadKeyInfo(tx, ctx.tenantId, spec, id, true);
  if (!before) throw new AppError('NOT_FOUND', `${spec.label}不存在`);
  await requireInScope(tx, ctx, spec, before);
  requireRevision(ctx, before.revision, spec.label);
  await tx.execute(sql`DELETE FROM ${sql.raw(spec.table)} WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, spec.object, 'delete', id, { before, after: null, employeeId: auditAnchor(spec, before) });
  return before;
}
