/**
 * 意向退休日期申请的读取、状态落库与审计（R2-T04 5d2，设计 §2.5 / §11）。表 retirement_intentions 一行 = 一张申请：
 * 路由、服务与审批适配器共用这里的加载、行锁、读范围谓词与审计。审计按字段级变更日志写（DEC-019），归属员工与申请时部门。
 */
import { sql, type Tx } from '@italent/db';
import type { RetirementIntentionState } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { auditEmployment } from './context.js';
import { employmentVisibilitySql } from './visibility.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const INTENTION_AUDIT_TYPE = 'retirement-intention';

/** 审计查看的创建人（使用用户维度）：申请发起人，同兼职申请口径（F-278）。intentionId 为 uuid 表达式。 */
export function intentionCreator(tenantId: string, intentionId: SQL): SQL {
  return sql`(SELECT q.initiator_user_id FROM retirement_intentions q
    WHERE q.tenant_id=${tenantId} AND q.id=${intentionId})`;
}

export interface IntentionRow {
  readonly id: string;
  readonly employeeId: string;
  readonly staffId: string;
  readonly departmentId: string | null;
  readonly intendedDate: string;
  readonly expectedDateSnapshot: string | null;
  readonly earliestSnapshot: string | null;
  readonly latestSnapshot: string | null;
  readonly reason: string | null;
  readonly initiator: 'hr' | 'self';
  readonly initiatorUserId: string;
  readonly state: RetirementIntentionState;
  readonly approvalInstanceId: string | null;
  readonly revision: number;
}

const COLUMNS = sql`id::text AS id, employee_id::text AS "employeeId", staff_id::text AS "staffId",
  department_id::text AS "departmentId", intended_date::text AS "intendedDate",
  expected_date_snapshot::text AS "expectedDateSnapshot", earliest_snapshot::text AS "earliestSnapshot",
  latest_snapshot::text AS "latestSnapshot", reason, initiator, initiator_user_id::text AS "initiatorUserId", state,
  approval_instance_id::text AS "approvalInstanceId", revision::integer AS revision`;

/** 接口形状：字段名取任职记录对象的字段目录（状态用系统字段 status），按调用方的字段查看权裁剪。 */
export function intentionView(row: IntentionRow) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    status: row.state,
    intendedDate: row.intendedDate,
    reason: row.reason,
    expectedDateSnapshot: row.expectedDateSnapshot,
    earliestSnapshot: row.earliestSnapshot,
    latestSnapshot: row.latestSnapshot,
    revision: row.revision,
  };
}

export async function loadIntention(tx: Tx, tenantId: string, id: string, lock = false): Promise<IntentionRow> {
  const [row] = rowsOf<IntentionRow>(
    await tx.execute(sql`SELECT ${COLUMNS} FROM retirement_intentions
      WHERE tenant_id=${tenantId} AND id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}`),
  );
  if (!row) throw new AppError('NOT_FOUND', '意向退休申请不存在');
  return row;
}

/**
 * 读范围谓词（对别名 r）：DEC-177 可见口径——员工当前部门或申请快照部门任一在范围内，使用用户维度取本表发起人。
 * 只管“看”；写入口径见 retirement-intention-access.ts（DEC-193）。
 */
export function intentionVisibilitySql(scope: EmploymentContext['scope']): SQL {
  return employmentVisibilitySql(scope, {
    employee: sql`r.employee_id`,
    department: sql`r.department_id`,
    creator: sql`r.initiator_user_id`,
  });
}

/** 详情：看不见与不存在同一个 404。 */
export async function loadVisibleIntention(tx: Tx, ctx: EmploymentContext, id: string): Promise<IntentionRow> {
  const [row] = rowsOf<IntentionRow>(
    await tx.execute(sql`SELECT ${COLUMNS} FROM retirement_intentions r
      WHERE r.tenant_id=${ctx.tenantId} AND r.id=${id}::uuid AND ${intentionVisibilitySql(ctx.scope)}`),
  );
  if (!row) throw new AppError('NOT_FOUND', '意向退休申请不存在');
  return row;
}

export interface IntentionFilter {
  readonly employeeId?: string;
  readonly state?: RetirementIntentionState;
}

/** 列表：按创建先后倒序；范围谓词在 LIMIT / OFFSET 之前，total 与本页同一范围。 */
export async function listIntentions(
  tx: Tx,
  ctx: EmploymentContext,
  filter: IntentionFilter,
  page: { readonly limit: number; readonly offset: number },
) {
  const where = sql`r.tenant_id=${ctx.tenantId} AND ${intentionVisibilitySql(ctx.scope)}
    AND (${filter.employeeId ?? null}::uuid IS NULL OR r.employee_id=${filter.employeeId ?? null}::uuid)
    AND (${filter.state ?? null}::text IS NULL OR r.state=${filter.state ?? null})`;
  const items = rowsOf<IntentionRow>(
    await tx.execute(sql`SELECT ${COLUMNS} FROM retirement_intentions r WHERE ${where}
      ORDER BY r.created_at DESC, r.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  const [count] = rowsOf<{ total: number }>(
    await tx.execute(sql`SELECT count(*)::integer AS total FROM retirement_intentions r WHERE ${where}`),
  );
  return { items, total: count?.total ?? 0 };
}

/** 该员工现有的未办结申请（至多一张，部分唯一索引同口径）。 */
export async function openIntentionOf(tx: Tx, tenantId: string, employeeId: string): Promise<string | null> {
  const [row] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id::text AS id FROM retirement_intentions
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid AND state IN ('draft','in_review','rejected')`),
  );
  return row?.id ?? null;
}

type Patch = Partial<
  Pick<
    IntentionRow,
    | 'intendedDate'
    | 'reason'
    | 'expectedDateSnapshot'
    | 'earliestSnapshot'
    | 'latestSnapshot'
    | 'state'
    | 'approvalInstanceId'
  >
>;
const COLUMN_OF: Readonly<Record<keyof Patch, string>> = {
  intendedDate: 'intended_date',
  reason: 'reason',
  expectedDateSnapshot: 'expected_date_snapshot',
  earliestSnapshot: 'earliest_snapshot',
  latestSnapshot: 'latest_snapshot',
  state: 'state',
  approvalInstanceId: 'approval_instance_id',
};
const CAST: Readonly<Partial<Record<keyof Patch, string>>> = {
  intendedDate: '::date',
  expectedDateSnapshot: '::date',
  earliestSnapshot: '::date',
  latestSnapshot: '::date',
  approvalInstanceId: '::uuid',
};

/** 保存一次修改（行已锁）：revision + 1，写字段级审计 retirement_intention.<action>。返回保存后的行。 */
export async function saveIntention(
  tx: Tx,
  ctx: EmploymentContext,
  before: IntentionRow,
  patch: Patch,
  action: string,
): Promise<IntentionRow> {
  const sets = (Object.entries(patch) as [keyof Patch, Patch[keyof Patch]][]).map(
    ([key, value]) => sql`${sql.raw(COLUMN_OF[key])} = ${value ?? null}${sql.raw(CAST[key] ?? '')}`,
  );
  await tx.execute(sql`UPDATE retirement_intentions SET ${sql.join(sets, sql`, `)}, revision = revision + 1,
      command_id = ${ctx.commandId}, updated_at = ${ctx.now.toISOString()}::timestamptz
    WHERE tenant_id=${ctx.tenantId} AND id=${before.id}::uuid`);
  const after = await loadIntention(tx, ctx.tenantId, before.id);
  await auditIntention(tx, ctx, action, before.id, before, after);
  return after;
}

export function auditIntention(
  tx: Tx,
  ctx: EmploymentContext,
  action: string,
  id: string,
  before: IntentionRow | null,
  after: IntentionRow,
) {
  const shape = (row: IntentionRow | null) => (row ? { ...intentionView(row), departmentId: row.departmentId } : null);
  return auditEmployment(
    tx,
    ctx,
    `retirement_intention.${action}`,
    INTENTION_AUDIT_TYPE,
    id,
    shape(before),
    shape(after),
    undefined,
    undefined,
    { employeeId: after.employeeId, orgId: after.departmentId },
  );
}
