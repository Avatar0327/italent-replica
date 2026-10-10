/**
 * 继任记录写入服务（设计 §5.1～§5.3、§7、§8.5）：新增（含历史补录）、编辑、批量结束、软删除。每个写入口在命令台账的同一
 * 租户事务里完成“业务写 + 审计”。锁序（R4-02，全部入口一致）：继任者员工行 FOR SHARE（仅新增 / 恢复生效）→ 目标锁行
 * （升序 FOR UPDATE）→ 记录行（升序 FOR UPDATE 重读）；结束 / 删除先无锁读出目标 ID（目标列不可改，集合稳定）再取锁。
 * 锁内重验：存在性与可见性（不可见与不存在同一个 404）、revision、计划屏障、日期、区间不重叠（DEC-305②）。
 */
import { pgErrorCode, sql, SUCCESSION_OPEN_END, type SuccessionType, type Tx } from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { scopeAllows } from '../permission/module-access.js';
import { selectReadiness } from '../talent-review/readiness-port.js';
import { codeOf } from './access.js';
import type { RecordCreate, RecordEnd, RecordPatch } from './input.js';
import { listRecordRows, type RecordRow, type RecordVisibility } from './record-read.js';
import { rowsOf, selfTargetSql, SUCCESSOR_INACTIVE_STATUSES } from './read-sql.js';
import { assertNoSyncBarrier } from './sync-barrier.js';
import type { StoredResult, WriteContext } from './write-support.js';

const RECORD = codeOf('record');
const notFound = () => new AppError('NOT_FOUND', '继任记录不存在');
const invalid = (reason: string, message: string, extra: object = {}) =>
  new AppError('VALIDATION_FAILED', message, { reason, ...extra });
const conflict = (reason: string, message: string, extra: object = {}) =>
  new AppError('CONFLICT', message, { reason, ...extra });

// ── 目标、继任者 ────────────────────────────────────────────────────────────────────────────

interface Target {
  readonly kind: SuccessionType;
  readonly id: string;
}
const keyOf = (target: Target) => `${target.kind}:${target.id}`;

/** 目标级序列化锁行：首次 INSERT … ON CONFLICT DO NOTHING 再 FOR UPDATE，按 (kind, id) 升序逐个取（§7）。 */
async function lockTargets(tx: Tx, tenantId: string, targets: readonly Target[]): Promise<void> {
  const unique = [...new Map(targets.map((target) => [keyOf(target), target])).values()].sort((a, b) =>
    keyOf(a) < keyOf(b) ? -1 : 1,
  );
  for (const { kind, id } of unique) {
    await tx.execute(sql`INSERT INTO succession_target_locks (tenant_id, target_kind, target_id)
      VALUES (${tenantId}::uuid, ${kind}, ${id}::uuid) ON CONFLICT DO NOTHING`);
    await tx.execute(sql`SELECT 1 FROM succession_target_locks
      WHERE tenant_id = ${tenantId}::uuid AND target_kind = ${kind} AND target_id = ${id}::uuid FOR UPDATE`);
  }
}

/** 目标当日有效且在操作人范围内（否则 404）；职位继任须是关键职位（400 TARGET_NOT_KEY_POSITION）。返回范围锚点组织。 */
async function requireTarget(tx: Tx, ctx: WriteContext, target: Target): Promise<string> {
  if (target.kind === 'org') {
    const [row] = rowsOf<{ org_id: string; enabled: boolean }>(
      await tx.execute(sql`SELECT v.org_id, v.enabled FROM org_versions v
        WHERE v.tenant_id = ${ctx.tenantId}::uuid AND v.org_id = ${target.id}::uuid
          AND v.start_date <= ${ctx.today}::date AND v.stop_date >= ${ctx.today}::date
        ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1`),
    );
    if (!row?.enabled || !scopeAllows(ctx.scope, { orgId: target.id })) throw new AppError('NOT_FOUND', '组织不存在');
    return target.id;
  }
  const [row] = rowsOf<{ org_id: string; enabled: boolean; is_key: boolean }>(
    await tx.execute(sql`SELECT v.org_id, v.enabled, v.is_key FROM job_position_versions v
      WHERE v.tenant_id = ${ctx.tenantId}::uuid AND v.object_id = ${target.id}::uuid
        AND v.start_date <= ${ctx.today}::date AND v.stop_date >= ${ctx.today}::date
      ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1`),
  );
  // 资源归属只按今天的管理范围判断（DEC-368①）：职位按今天所属的组织
  if (!row?.enabled || !scopeAllows(ctx.scope, { orgId: row.org_id })) throw new AppError('NOT_FOUND', '职位不存在');
  if (!row.is_key) throw invalid('TARGET_NOT_KEY_POSITION', '继任职位必须是关键职位');
  return row.org_id;
}

/** 本人（目标的负责人 / 现任）的记录按保守口径不可写，命令前 404（设计 §8.4，Q-SC-17）。 */
async function rejectSelfTarget(tx: Tx, ctx: WriteContext, type: SuccessionType, target: string): Promise<void> {
  const [row] = rowsOf<{ self: boolean }>(
    await tx.execute(
      sql`SELECT ${selfTargetSql(
        ctx,
        {
          type: sql`${type}`,
          org: sql`${type === 'org' ? target : null}`,
          position: sql`${type === 'position' ? target : null}`,
        },
        ctx.today,
      )} AS self`,
    ),
  );
  if (row?.self) throw notFound();
}

/**
 * 继任者须在职（含待入职；不是调出 4 / 退休 6 / 离职 8，§4.1），**不校验是否在操作人员工范围内**（DEC-308）。
 * 同时对员工行加 FOR SHARE：与任职写入的 FOR NO KEY UPDATE 互斥，离职与新增不会交错（§7）。
 */
async function lockActiveSuccessor(tx: Tx, ctx: WriteContext, employeeId: string): Promise<void> {
  const [row] = rowsOf<{ status: number | null }>(
    await tx.execute(sql`SELECT s.employee_status::int AS status
      FROM employment_employees e
      LEFT JOIN employment_timeline t ON t.tenant_id = e.tenant_id AND t.employee_id = e.id
        AND t.valid_during @> ${ctx.today}::date
      LEFT JOIN employment_records r ON r.tenant_id = t.tenant_id AND r.id = t.record_id
      LEFT JOIN LATERAL employment_record_status(e.tenant_id, r.id) s ON true
      WHERE e.tenant_id = ${ctx.tenantId}::uuid AND e.id = ${employeeId}::uuid
      LIMIT 1 FOR SHARE OF e`),
  );
  if (!row) throw new AppError('NOT_FOUND', '继任者不存在');
  if (row.status !== null && SUCCESSOR_INACTIVE_STATUSES.includes(row.status)) {
    throw invalid('SUCCESSOR_NOT_ACTIVE', '继任者已离职、调出或退休，不能作为继任者');
  }
}

// ── 日期、区间 ──────────────────────────────────────────────────────────────────────────────

/** 日期规则（§5.1）：开始 ≤ 今天；给出结束时 ≤ 今天且 ≥ 开始。 */
function checkDates(ctx: WriteContext, start: string, end: string | null, check: { start: boolean; end: boolean }) {
  if (check.start && start > ctx.today) throw invalid('START_DATE_IN_FUTURE', '开始时间不可以大于今天');
  if (check.end && end && end > ctx.today) throw invalid('END_DATE_IN_FUTURE', '结束时间不可以大于今天');
  if (end && end < start) throw invalid('END_BEFORE_START', '结束时间不能早于开始时间');
}

/** 区间不重叠（DEC-305②）：与当前生效记录重叠 → SUCCESSION_DUPLICATE；只与历史记录重叠 → SUCCESSION_PERIOD_OVERLAP。 */
async function checkOverlap(
  tx: Tx,
  ctx: WriteContext,
  record: { type: SuccessionType; target: string; successor: string; start: string; end: string | null },
  selfId?: string,
): Promise<void> {
  const rows = rowsOf<{ active: boolean }>(
    await tx.execute(sql`SELECT (end_date > ${ctx.today}::date) AS active FROM succession_records
      WHERE tenant_id = ${ctx.tenantId}::uuid AND deleted_at IS NULL AND succession_type = ${record.type}
        AND COALESCE(target_org_id, target_position_id) = ${record.target}::uuid
        AND successor_employee_id = ${record.successor}::uuid
        ${selfId ? sql`AND id <> ${selfId}::uuid` : sql``}
        AND daterange(start_date, end_date, '[)')
          && daterange(${record.start}::date, ${record.end ?? SUCCESSION_OPEN_END}::date, '[)')`),
  );
  if (!rows.length) return;
  if (rows.some((row) => row.active)) {
    throw conflict('SUCCESSION_DUPLICATE', '与已存在的继任信息重复');
  }
  throw conflict('SUCCESSION_PERIOD_OVERLAP', '开始时间与历史的继任信息时间段重叠');
}

/** 排他约束兜底（并发写入者，如同步执行）：23P01 按冲突类型同样映射成 409。 */
async function guardExclusion<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (pgErrorCode(error) === '23P01') throw conflict('SUCCESSION_PERIOD_OVERLAP', '继任信息时间段与已有记录重叠');
    throw error;
  }
}

// ── 审计 ────────────────────────────────────────────────────────────────────────────────────

const snapshot = (row: Record<string, unknown> | RecordRow) => {
  const r = row as Record<string, unknown>;
  const pick = (camel: string, snake: string) => (r[camel] ?? r[snake] ?? null) as unknown;
  return {
    successionType: pick('successionType', 'succession_type'),
    targetOrgId: pick('targetOrgId', 'target_org_id'),
    targetPositionId: pick('targetPositionId', 'target_position_id'),
    successorEmployeeId: pick('successorEmployeeId', 'successor_employee_id'),
    readinessId: pick('readinessId', 'readiness_id'),
    backupType: pick('backupType', 'backup_type'),
    startDate: pick('startDate', 'start_date'),
    endDate: pick('endDate', 'end_date'),
    endReason: pick('endReason', 'end_reason'),
    endSource: pick('endSource', 'end_source'),
    revision: pick('revision', 'revision'),
  };
};

async function audit(
  tx: Tx,
  ctx: WriteContext,
  operation: 'create' | 'update' | 'delete',
  id: string,
  orgId: string,
  change: { before: unknown; after: unknown },
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `succession.record.${operation}`,
    objectType: RECORD,
    objectId: id,
    before: change.before,
    after: change.after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    scope: { orgId },
  });
}

// ── 读取与加锁 ──────────────────────────────────────────────────────────────────────────────

interface LockedRow {
  readonly id: string;
  readonly type: SuccessionType;
  readonly targetOrgId: string | null;
  readonly targetPositionId: string | null;
  readonly successorId: string;
  readonly revision: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly readinessId: string | null;
  readonly deleted: boolean;
  readonly raw: Record<string, unknown>;
}

const toLocked = (row: Record<string, unknown>): LockedRow => ({
  id: row.id as string,
  type: row.succession_type as SuccessionType,
  targetOrgId: (row.target_org_id as string | null) ?? null,
  targetPositionId: (row.target_position_id as string | null) ?? null,
  successorId: row.successor_employee_id as string,
  revision: Number(row.revision),
  startDate: row.start_date as string,
  endDate: row.end_date as string,
  readinessId: (row.readiness_id as string | null) ?? null,
  deleted: row.deleted_at !== null && row.deleted_at !== undefined,
  raw: row,
});
const targetOf = (row: LockedRow): Target =>
  row.type === 'org' ? { kind: 'org', id: row.targetOrgId! } : { kind: 'position', id: row.targetPositionId! };

const COLUMNS = sql`id, succession_type, target_org_id, target_position_id, successor_employee_id, readiness_id,
  backup_type, start_date::text AS start_date, end_date::text AS end_date, end_reason, end_source, revision,
  deleted_at`;

/** 无锁读（只取目标 / 继任者定位，用于决定取锁顺序）。 */
async function peekRows(tx: Tx, ctx: WriteContext, ids: readonly string[]): Promise<LockedRow[]> {
  return rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT ${COLUMNS} FROM succession_records
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ANY(${`{${ids.join(',')}}`}::uuid[]) AND deleted_at IS NULL`),
  ).map(toLocked);
}

/** 记录行升序 FOR UPDATE 重读；取锁前被删 / 不存在 → 404。 */
async function lockRows(tx: Tx, ctx: WriteContext, ids: readonly string[]): Promise<LockedRow[]> {
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT ${COLUMNS} FROM succession_records
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ANY(${`{${ids.join(',')}}`}::uuid[]) AND deleted_at IS NULL
      ORDER BY id FOR UPDATE`),
  ).map(toLocked);
  if (rows.length !== ids.length) throw notFound();
  return rows;
}

/** 范围内可见 + 非本人（SELF 保守不可写）：不可见与不存在同一个 404，任一条不可见整批 404。 */
async function requireWritable(tx: Tx, ctx: WriteContext, rows: readonly LockedRow[]): Promise<Map<string, RecordRow>> {
  const visibility: RecordVisibility = {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    today: ctx.today,
    asOf: ctx.today,
    scope: ctx.scope,
  };
  const { rows: visible } = await listRecordRows(
    tx,
    visibility,
    { status: 'all', ids: rows.map((row) => row.id) },
    { limit: rows.length, offset: 0 },
  );
  if (visible.length !== rows.length) throw notFound();
  for (const row of rows) await rejectSelfTarget(tx, ctx, row.type, targetOf(row).id);
  return new Map(visible.map((row) => [row.id, row]));
}

/** 记录所属的范围锚点组织（审计 scope）：组织继任 = 目标组织；职位继任 = 职位今天所属的组织。 */
async function anchorOrg(tx: Tx, ctx: WriteContext, row: LockedRow): Promise<string> {
  if (row.type === 'org') return row.targetOrgId!;
  const [position] = rowsOf<{ org_id: string }>(
    await tx.execute(sql`SELECT v.org_id FROM job_position_versions v
      WHERE v.tenant_id = ${ctx.tenantId}::uuid AND v.object_id = ${row.targetPositionId}::uuid
        AND v.start_date <= ${ctx.today}::date ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1`),
  );
  if (!position) throw notFound();
  return position.org_id;
}

function checkRevision(rows: readonly LockedRow[], expected: ReadonlyMap<string, number>): void {
  const stale = rows.filter((row) => row.revision !== expected.get(row.id));
  if (stale.length) {
    throw new AppError('REVISION_CONFLICT', '继任记录已变更，请刷新后显式重提', { ids: stale.map((row) => row.id) });
  }
}

// ── 新增 ────────────────────────────────────────────────────────────────────────────────────

export async function createRecord(tx: Tx, ctx: WriteContext, body: RecordCreate): Promise<StoredResult> {
  const target: Target =
    body.successionType === 'org'
      ? { kind: 'org', id: body.targetOrgId! }
      : { kind: 'position', id: body.targetPositionId! };
  const end = body.endDate ?? null;
  checkDates(ctx, body.startDate, end, { start: true, end: true });
  // 锁序：继任者员工行 FOR SHARE → 目标锁行 → （新记录没有已存在的行）
  await lockActiveSuccessor(tx, ctx, body.successorEmployeeId);
  await lockTargets(tx, ctx.tenantId, [target]);
  await assertNoSyncBarrier(tx, ctx.tenantId, [target]);
  const orgId = await requireTarget(tx, ctx, target);
  await rejectSelfTarget(tx, ctx, target.kind, target.id);
  if (body.readinessId) await selectReadiness(tx, ctx.tenantId, body.readinessId);
  await checkOverlap(tx, ctx, {
    type: target.kind,
    target: target.id,
    successor: body.successorEmployeeId,
    start: body.startDate,
    end,
  });
  const now = ctx.now.toISOString();
  const [created] = rowsOf<Record<string, unknown>>(
    await guardExclusion(() =>
      tx.execute(sql`INSERT INTO succession_records
        (tenant_id, succession_type, target_org_id, target_position_id, successor_employee_id, readiness_id,
         backup_type, start_date, end_date, end_reason, end_source, ended_at, ended_by, source_kind, created_by,
         updated_by, created_at, updated_at)
        VALUES (${ctx.tenantId}::uuid, ${target.kind}, ${target.kind === 'org' ? target.id : null}::uuid,
          ${target.kind === 'position' ? target.id : null}::uuid, ${body.successorEmployeeId}::uuid,
          ${body.readinessId ?? null}::uuid, ${body.backupType ?? 'principal'}, ${body.startDate}::date,
          ${end ?? SUCCESSION_OPEN_END}::date, ${end ? (body.endReason ?? null) : null}, ${end ? 'manual' : null},
          ${end ? now : null}::timestamptz, ${end ? ctx.userId : null}::uuid, 'manual', ${ctx.userId}::uuid,
          ${ctx.userId}::uuid, ${now}::timestamptz, ${now}::timestamptz)
        RETURNING ${COLUMNS}`),
    ),
  );
  const row = created!;
  await audit(tx, ctx, 'create', row.id as string, orgId, { before: null, after: snapshot(row) });
  return { kind: 'record', ids: [row.id as string] };
}

// ── 编辑 ────────────────────────────────────────────────────────────────────────────────────

export async function updateRecord(tx: Tx, ctx: WriteContext, id: string, body: RecordPatch): Promise<StoredResult> {
  const [peek] = await peekRows(tx, ctx, [id]);
  if (!peek) throw notFound();
  const restoring = body.endDate === null;
  // 锁序：继任者员工行 FOR SHARE（恢复生效要重验在职）→ 目标锁行 → 记录行
  if (restoring) await lockActiveSuccessor(tx, ctx, peek.successorId);
  const target = targetOf(peek);
  await lockTargets(tx, ctx.tenantId, [target]);
  const [row] = await lockRows(tx, ctx, [id]);
  await requireWritable(tx, ctx, [row!]);
  checkRevision([row!], new Map([[id, ctx.expectedRevision]]));
  await assertNoSyncBarrier(tx, ctx.tenantId, [target]);

  const start = body.startDate ?? row!.startDate;
  const wasOpen = row!.endDate === SUCCESSION_OPEN_END;
  const end = body.endDate === undefined ? (wasOpen ? null : row!.endDate) : body.endDate;
  checkDates(ctx, start, end, { start: body.startDate !== undefined, end: body.endDate != null });
  if (body.readinessId && body.readinessId !== row!.readinessId)
    await selectReadiness(tx, ctx.tenantId, body.readinessId);
  const datesChanged = body.startDate !== undefined || body.endDate !== undefined;
  if (restoring && !wasOpen) await requireTarget(tx, ctx, target); // 恢复生效：目标仍须有效 / 关键 / 在范围
  if (datesChanged) {
    await checkOverlap(tx, ctx, { type: row!.type, target: target.id, successor: row!.successorId, start, end }, id);
  }
  const now = ctx.now.toISOString();
  const closing = end !== null && wasOpen;
  const sets = [
    sql`revision = revision + 1`,
    sql`updated_by = ${ctx.userId}::uuid`,
    sql`updated_at = ${now}::timestamptz`,
    ...(body.readinessId !== undefined ? [sql`readiness_id = ${body.readinessId}::uuid`] : []),
    ...(body.backupType !== undefined ? [sql`backup_type = ${body.backupType}`] : []),
    ...(body.startDate !== undefined ? [sql`start_date = ${body.startDate}::date`] : []),
    ...(body.endDate !== undefined ? [sql`end_date = ${end ?? SUCCESSION_OPEN_END}::date`] : []),
    ...(restoring ? [sql`end_reason = NULL`, sql`end_source = NULL`, sql`ended_at = NULL`, sql`ended_by = NULL`] : []),
    ...(body.endReason !== undefined && !restoring ? [sql`end_reason = ${body.endReason}`] : []),
    ...(closing
      ? [sql`end_source = 'manual'`, sql`ended_at = ${now}::timestamptz`, sql`ended_by = ${ctx.userId}::uuid`]
      : []),
  ];
  const [after] = rowsOf<Record<string, unknown>>(
    await guardExclusion(() =>
      tx.execute(sql`UPDATE succession_records SET ${sql.join(sets, sql`, `)}
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid RETURNING ${COLUMNS}`),
    ),
  );
  await audit(tx, ctx, 'update', id, await anchorOrg(tx, ctx, row!), {
    before: snapshot(row!.raw),
    after: snapshot(after!),
  });
  return { kind: 'record', ids: [id] };
}

// ── 批量结束 ────────────────────────────────────────────────────────────────────────────────

export async function endRecords(tx: Tx, ctx: WriteContext, body: RecordEnd): Promise<StoredResult> {
  if (body.endDate > ctx.today) throw invalid('END_DATE_IN_FUTURE', '结束时间不可以大于今天');
  const ids = body.items.map((item) => item.id).sort();
  // R4-02：先无锁读出目标 → 目标锁行升序 → 记录行升序 FOR UPDATE 重读，用重读后的状态做校验
  const peeked = await peekRows(tx, ctx, ids);
  if (peeked.length !== ids.length) throw notFound();
  const targets = peeked.map(targetOf);
  await lockTargets(tx, ctx.tenantId, targets);
  const rows = await lockRows(tx, ctx, ids);
  await requireWritable(tx, ctx, rows);

  const early = rows.filter((row) => body.endDate < row.startDate);
  if (early.length) {
    throw invalid('END_BEFORE_START', '结束时间不能早于开始时间', { ids: early.map((row) => row.id) });
  }
  const ended = rows.filter((row) => row.endDate <= ctx.today);
  if (ended.length) throw conflict('ALREADY_ENDED', '记录已结束', { ids: ended.map((row) => row.id) });
  checkRevision(rows, new Map(body.items.map((item) => [item.id, item.expectedRevision])));
  await assertNoSyncBarrier(tx, ctx.tenantId, targets);

  const now = ctx.now.toISOString();
  for (const row of rows) {
    const [after] = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`UPDATE succession_records SET end_date = ${body.endDate}::date,
          end_reason = ${body.endReason ?? null}, end_source = 'manual', ended_at = ${now}::timestamptz,
          ended_by = ${ctx.userId}::uuid, revision = revision + 1, updated_by = ${ctx.userId}::uuid,
          updated_at = ${now}::timestamptz
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${row.id}::uuid RETURNING ${COLUMNS}`),
    );
    await audit(tx, ctx, 'update', row.id, await anchorOrg(tx, ctx, row), {
      before: snapshot(row.raw),
      after: snapshot(after!),
    });
  }
  return { kind: 'records', ids: body.items.map((item) => item.id) };
}

// ── 软删除 ──────────────────────────────────────────────────────────────────────────────────

export async function deleteRecord(tx: Tx, ctx: WriteContext, id: string): Promise<StoredResult> {
  const [peek] = await peekRows(tx, ctx, [id]);
  if (!peek) throw notFound();
  const target = targetOf(peek);
  await lockTargets(tx, ctx.tenantId, [target]);
  const [row] = await lockRows(tx, ctx, [id]);
  await requireWritable(tx, ctx, [row!]);
  checkRevision([row!], new Map([[id, ctx.expectedRevision]]));
  await assertNoSyncBarrier(tx, ctx.tenantId, [target]);
  const now = ctx.now.toISOString();
  await tx.execute(sql`UPDATE succession_records SET deleted_at = ${now}::timestamptz,
      deleted_by = ${ctx.userId}::uuid, revision = revision + 1, updated_by = ${ctx.userId}::uuid,
      updated_at = ${now}::timestamptz
    WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
  await audit(tx, ctx, 'delete', id, await anchorOrg(tx, ctx, row!), { before: snapshot(row!.raw), after: null });
  return { kind: 'receipt', ids: [id] };
}
