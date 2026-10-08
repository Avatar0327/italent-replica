/**
 * 关键信息维护：带教 / 职业发展 / 轮岗（docs/02_业务建模/28 IDP-R19～R22；PR 描述 K-35）。
 * - 判重键：带教 = 带教人 + 被带教人 + 起止；职业发展 = 员工 + 起止；轮岗 = 员工 + 部门 + 职位 + 起止（🟡 加员工）；
 * - 员工须在操作人 IDP 范围内（带教双方都须在范围内，范围外 404），轮岗部门须在范围内（管理单元限制，IDP-R21）；
 * - 写入与审计同事务，审计按员工（带教按被带教人）归属。
 */
import { pgErrorCode, sql, type Tx } from '@italent/db';
import type { IdpObject } from '@italent/domain';
import { AppError } from '../../errors.js';
import { scopeAllowsInTransaction } from '../permission/module-access.js';
import { type ModuleScope, rowsOf } from './access.js';
import { employeeInScope } from './plan-access.js';
import { audit, conflict, created, requireRevision, type WriteContext } from './write-support.js';

export type KeyInfoKind = 'tutorship' | 'career' | 'workShift';

interface KeyInfoSpec {
  readonly object: IdpObject & KeyInfoKind;
  readonly table: string;
  /** 字段 → 列。 */
  readonly columns: Readonly<Record<string, string>>;
  /** 须在范围内的员工字段（第一个是审计归属）。 */
  readonly persons: readonly string[];
  /** 须在范围内的组织字段。 */
  readonly orgs: readonly string[];
  readonly duplicate: string;
  readonly label: string;
}

const dated = { startDate: 'start_date', endDate: 'end_date' };

export const KEY_INFO: Readonly<Record<KeyInfoKind, KeyInfoSpec>> = {
  tutorship: {
    object: 'tutorship',
    table: 'idp_tutorships',
    columns: { tutorEmployeeId: 'tutor_employee_id', tuteeEmployeeId: 'tutee_employee_id', remark: 'remark', ...dated },
    persons: ['tuteeEmployeeId', 'tutorEmployeeId'],
    orgs: [],
    duplicate: 'IDP_TUTORSHIP_DUPLICATE',
    label: '带教信息',
  },
  career: {
    object: 'career',
    table: 'idp_careers',
    columns: {
      employeeId: 'employee_id',
      targetPositionId: 'target_position_id',
      strengths: 'strengths',
      developmentItems: 'development_items',
      intendedCity: 'intended_city',
      ...dated,
    },
    persons: ['employeeId'],
    orgs: [],
    duplicate: 'IDP_CAREER_DUPLICATE',
    label: '职业发展信息',
  },
  workShift: {
    object: 'workShift',
    table: 'idp_work_shifts',
    columns: {
      employeeId: 'employee_id',
      orgId: 'org_id',
      positionId: 'position_id',
      mentorEmployeeId: 'mentor_employee_id',
      ...dated,
    },
    persons: ['employeeId'],
    orgs: ['orgId'],
    duplicate: 'IDP_WORK_SHIFT_DUPLICATE',
    label: '轮岗信息',
  },
};

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

/** 记录的员工 / 部门都在范围内（范围外与不存在同为 404）。 */
export async function inScope(tx: Tx, scope: ModuleScope, spec: KeyInfoSpec, row: Record<string, unknown>) {
  for (const field of spec.persons) {
    if (!(await employeeInScope(tx, scope, row[field] as string))) return false;
  }
  for (const field of spec.orgs) {
    if (!(await scopeAllowsInTransaction(tx, scope, { orgId: row[field] as string }))) return false;
  }
  return true;
}

/** 列表：按第一个员工字段（带教按被带教人）在范围内过滤（分页之前）。 */
export async function listKeyInfo(
  tx: Tx,
  tenantId: string,
  spec: KeyInfoSpec,
  visible: (person: ReturnType<typeof sql>) => ReturnType<typeof sql>,
  page: { limit: number; offset: number },
  employeeId?: string,
) {
  const anchor = sql.raw(spec.columns[spec.persons[0]!]!);
  return rowsOf<KeyInfoRow>(
    await tx.execute(sql`SELECT ${selectList(spec)} FROM ${sql.raw(spec.table)}
      WHERE tenant_id = ${tenantId} AND ${visible(anchor)}
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
