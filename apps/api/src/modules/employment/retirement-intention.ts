/**
 * 意向退休日期申请服务（R2-T04 5d2，设计 §2.5 / §11）：创建、修改、提交（含驳回后重提）、撤回，以及审批结论回写。
 * 按 initiation = hr | self 设计（同 R2-T03 §4B），5d2 只开 HR 入口，自助入口随 F-020。
 * 取锁顺序：员工 → 申请行 → 审批实例（与审批适配器的 lock 同序）；写范围在任何写之前判定（requireIntentionWriteScope）。
 * 审批通过只置 approved，不写人事字段（A-6，DEC-637 / DEC-638）；审批中心（approval/）经动态导入调用，避免静态环。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import {
  intentionDateViolation,
  RETIREMENT_INTENTION_EMPLOYED_STATUSES,
  RETIREMENT_INTENTION_REASON_MAX,
  RETIREMENT_INTENTION_OPEN_STATES,
  tenantLocalDate,
} from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { schedulerAwareContext, type ApprovalContext, type FieldAccess } from '../approval/context.js';
import { assertRevision } from './context.js';
import { requireIntentionWriteScope } from './retirement-intention-access.js';
import {
  auditIntention,
  loadIntention,
  openIntentionOf,
  saveIntention,
  type IntentionRow,
} from './retirement-intention-store.js';
import { findCurrentRecord } from './read-model.js';
import { lockEmploymentEmployee, rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

const date = z.iso.date();
const reason = z.string().trim().max(RETIREMENT_INTENTION_REASON_MAX);

/** 创建体：意向日期必填，原因可选。 */
const createSchema = z.strictObject({ intendedDate: date, reason: reason.nullable().optional() });
/** 修改体：至少一项；原因可清空。 */
const patchSchema = z
  .strictObject({ intendedDate: date.optional(), reason: reason.nullable().optional() })
  .refine((value) => Object.keys(value).length > 0, '至少修改一项');
export type IntentionCreateInput = z.infer<typeof createSchema>;
export type IntentionPatch = z.infer<typeof patchSchema>;

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '意向退休申请字段不合法', parsed.error.issues);
  return parsed.data;
}
export const parseIntentionCreate = (raw: unknown) => parseWith(createSchema, raw);
export const parseIntentionPatch = (raw: unknown) => parseWith(patchSchema, raw);

const conflict = (reasonCode: string, message: string, details: Record<string, unknown> = {}) =>
  new AppError('CONFLICT', message, { reason: reasonCode, ...details });

/** 人员当前（最新版本）的预计退休日期与弹性上下限；调用方已持员工行锁。 */
async function retirementFacts(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const [row] = rowsOf<{ expected: string | null; earliest: string | null; latest: string | null }>(
    await tx.execute(sql`SELECT expected_retirement_date::text AS expected, earliest_retirement_date::text AS earliest,
        latest_retirement_date::text AS latest FROM personnel_employee_versions
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid ORDER BY revision DESC LIMIT 1`),
  );
  return row ?? { expected: null, earliest: null, latest: null };
}

/** 员工当前在职（主职任职的人员状态），返回当前任职记录供取任职周期与部门快照。 */
async function employedRecord(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const current = await findCurrentRecord(tx, ctx.tenantId, employeeId, tenantLocalDate(ctx.now, ctx.timezone));
  if (!current || !RETIREMENT_INTENTION_EMPLOYED_STATUSES.includes(current.employeeStatus))
    throw conflict('RETIREMENT_INTENTION_NOT_EMPLOYED', '只有当前在职的员工可以提出意向退休日期申请');
  return current;
}

/** 日期校验（今天之后；有弹性上下限时落在其内）并返回将冻结的快照三项。 */
async function checkedSnapshots(tx: Tx, ctx: EmploymentContext, employeeId: string, intendedDate: string) {
  const facts = await retirementFacts(tx, ctx, employeeId);
  const violation = intentionDateViolation({
    intendedDate,
    today: tenantLocalDate(ctx.now, ctx.timezone),
    earliest: facts.earliest,
    latest: facts.latest,
  });
  if (violation === 'RETIREMENT_INTENTION_NOT_FUTURE')
    throw new AppError('VALIDATION_FAILED', '意向退休日期必须晚于今天', { reason: violation });
  if (violation)
    throw new AppError('VALIDATION_FAILED', '意向退休日期不在弹性退休范围内', {
      reason: violation,
      earliest: facts.earliest,
      latest: facts.latest,
    });
  return { expectedDateSnapshot: facts.expected, earliestSnapshot: facts.earliest, latestSnapshot: facts.latest };
}

/** 锁序入口：员工 → 申请行；调用方随后（审批动作内）才锁实例。 */
export async function lockIntention(tx: Tx, ctx: EmploymentContext, id: string): Promise<IntentionRow> {
  const peek = await loadIntention(tx, ctx.tenantId, id);
  await lockEmploymentEmployee(tx, ctx, peek.employeeId);
  return loadIntention(tx, ctx.tenantId, id, true);
}

/**
 * 创建草稿：If-Match = 员工 revision；校验在任何写之前，写范围用即将写入的快照部门。initiation 缺省 hr（5d2 只开 HR 入口），
 * self 随 F-020 自助入口接入（本人范围、发起人 = 员工账号）。
 */
export async function createIntention(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: IntentionCreateInput,
  initiation: IntentionRow['initiator'] = 'hr',
): Promise<IntentionRow> {
  await lockEmploymentEmployee(tx, ctx, employeeId, ctx.expectedRevision);
  const current = await employedRecord(tx, ctx, employeeId);
  const departmentId = current.fields.departmentId ?? null;
  await requireIntentionWriteScope(tx, ctx, { employeeId, departmentId, initiatorUserId: ctx.userId });
  if (await openIntentionOf(tx, ctx.tenantId, employeeId))
    throw conflict('RETIREMENT_INTENTION_IN_PROGRESS', '该员工已有未办结的意向退休日期申请');
  const snapshots = await checkedSnapshots(tx, ctx, employeeId, input.intendedDate);
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO retirement_intentions(id, tenant_id, employee_id, staff_id, department_id,
      intended_date, expected_date_snapshot, earliest_snapshot, latest_snapshot, reason, initiator, initiator_user_id,
      state, revision, command_id, created_at, updated_at)
    VALUES (${id}::uuid, ${ctx.tenantId}, ${employeeId}::uuid, ${current.staffId}::uuid, ${departmentId}::uuid,
      ${input.intendedDate}::date, ${snapshots.expectedDateSnapshot}::date, ${snapshots.earliestSnapshot}::date,
      ${snapshots.latestSnapshot}::date, ${input.reason ?? null}, ${initiation}, ${ctx.userId}::uuid, 'draft', 1,
      ${ctx.commandId}, ${ctx.now.toISOString()}::timestamptz, ${ctx.now.toISOString()}::timestamptz)`);
  const created = await loadIntention(tx, ctx.tenantId, id);
  await auditIntention(tx, ctx, 'create', id, null, created);
  return created;
}

const EDITABLE: readonly IntentionRow['state'][] = ['draft', 'rejected'];

/** 行已锁后的共同前置：If-Match、写范围（先于业务状态判断，范围外与不存在同一个 404）。 */
async function guardedRow(tx: Tx, ctx: EmploymentContext, id: string): Promise<IntentionRow> {
  const row = await lockIntention(tx, ctx, id);
  await requireIntentionWriteScope(tx, ctx, row);
  assertRevision(ctx.expectedRevision, row.revision);
  return row;
}

/** 修改草稿 / 已驳回的申请：意向日期与原因；日期按当前预计退休日期与弹性范围重校验并刷新快照。 */
export async function updateIntention(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  patch: IntentionPatch,
): Promise<IntentionRow> {
  const row = await guardedRow(tx, ctx, id);
  if (!EDITABLE.includes(row.state))
    throw conflict(
      row.state === 'in_review' ? 'RETIREMENT_INTENTION_IN_APPROVAL' : 'RETIREMENT_INTENTION_NOT_EDITABLE',
      row.state === 'in_review' ? '申请审批中，不能修改，请先撤回' : '该申请已办结，不能修改',
      { status: row.state },
    );
  await employedRecord(tx, ctx, row.employeeId);
  const intendedDate = patch.intendedDate ?? row.intendedDate;
  const snapshots = await checkedSnapshots(tx, ctx, row.employeeId, intendedDate);
  return saveIntention(
    tx,
    ctx,
    row,
    { ...snapshots, intendedDate, ...(patch.reason !== undefined ? { reason: patch.reason } : {}) },
    'update',
  );
}

const approvalContext = (ctx: EmploymentContext, fields?: FieldAccess): ApprovalContext =>
  ({ ...ctx, expectedRevision: 0, ...(fields ? { fields } : {}) }) as ApprovalContext;

/** 把审批实例编号回写到申请行（同事务，提交后立即可读）。 */
async function linkInstance(tx: Tx, ctx: EmploymentContext, row: IntentionRow): Promise<IntentionRow> {
  const { activeInstanceOf } = await import('../approval/store.js');
  const active = await activeInstanceOf(tx, ctx.tenantId, 'retirement_intention', row.id);
  if (!active || active.id === row.approvalInstanceId) return row;
  await tx.execute(sql`UPDATE retirement_intentions SET approval_instance_id=${active.id}::uuid
    WHERE tenant_id=${ctx.tenantId} AND id=${row.id}::uuid`);
  return loadIntention(tx, ctx.tenantId, row.id);
}

/**
 * 提交（含驳回后重提，沿用原实例，DEC-103）：只允许原发起人（DEC-113），重判在职与日期并刷新快照后置 in_review，
 * 再交审批中心匹配流程；没有匹配的流程 / 首节点无审批人时整单回滚，申请保持原状态（DEC-017 / DEC-054）。
 */
export async function submitIntention(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  fields?: FieldAccess,
): Promise<IntentionRow> {
  const row = await guardedRow(tx, ctx, id);
  if (!EDITABLE.includes(row.state))
    throw conflict('RETIREMENT_INTENTION_NOT_SUBMITTABLE', '只有草稿或已驳回的申请可以提交', { status: row.state });
  if (row.initiatorUserId !== ctx.userId)
    throw new AppError('FORBIDDEN', '只有原发起人可以提交该申请', { reason: 'RETIREMENT_INTENTION_INITIATOR_ONLY' });
  await employedRecord(tx, ctx, row.employeeId);
  const snapshots = await checkedSnapshots(tx, ctx, row.employeeId, row.intendedDate);
  const submitted = await saveIntention(tx, ctx, row, { ...snapshots, state: 'in_review' }, 'submit');
  const { startOrResume } = await import('../approval/engine.js');
  await startOrResume(tx, approvalContext(ctx, fields), { businessType: 'retirement_intention', businessId: id });
  return linkInstance(tx, ctx, submitted);
}

/** 撤回：草稿 / 审批中 / 已驳回 → 已撤回（终态，释放“同员工一张”占位）；审批中与已驳回的实例一并结束。 */
export async function withdrawIntention(tx: Tx, ctx: EmploymentContext, id: string): Promise<IntentionRow> {
  const row = await guardedRow(tx, ctx, id);
  if (!RETIREMENT_INTENTION_OPEN_STATES.includes(row.state))
    throw conflict('RETIREMENT_INTENTION_NOT_WITHDRAWABLE', '该申请已办结，不能撤回', { status: row.state });
  // 草稿任何有范围的 HR 可撤；已提交的实例只有发起人可撤回（审批中心同口径）
  if (row.state !== 'draft' && row.initiatorUserId !== ctx.userId)
    throw new AppError('FORBIDDEN', '只有原发起人可以撤回该申请', { reason: 'RETIREMENT_INTENTION_INITIATOR_ONLY' });
  const withdrawn = await saveIntention(tx, ctx, row, { state: 'withdrawn' }, 'withdraw');
  const { activeInstanceOf } = await import('../approval/store.js');
  const { withdraw } = await import('../approval/actions.js');
  const active = await activeInstanceOf(tx, ctx.tenantId, 'retirement_intention', id);
  if (active) await withdraw(tx, schedulerAwareContext(approvalContext(ctx)), active.id, true);
  return withdrawn;
}

/**
 * 审批中心回写结论（适配器调用，审批人只操作本单，不走 HR 员工范围，DEC-057）：只处理仍在审批中的申请，重复回调不重复写。
 * approved 只置状态、不写人事字段（A-6）；withdrawn = 审批侧撤回，rejected = 驳回到发起人（可修改后重提）。
 */
export async function settleIntentionFromApproval(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  outcome: 'approved' | 'rejected' | 'disapproved' | 'withdrawn',
): Promise<void> {
  const row = await lockIntention(tx, ctx, id);
  const live =
    outcome === 'withdrawn' ? row.state === 'in_review' || row.state === 'rejected' : row.state === 'in_review';
  if (!live) return;
  await saveIntention(tx, ctx, row, { state: outcome }, outcome === 'withdrawn' ? 'withdraw' : outcome);
}

/** 审批侧同单重提（驳回后）：重判在职与日期、刷新快照，可带修正（意向日期 / 原因）。 */
export async function resubmitIntentionFromApproval(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  corrections: Readonly<Record<string, unknown>>,
): Promise<void> {
  const row = await lockIntention(tx, ctx, id);
  if (row.state !== 'rejected')
    throw conflict('RETIREMENT_INTENTION_NOT_REJECTED', '只有被驳回的申请可以重新提交', { status: row.state });
  const patch = Object.keys(corrections).length ? parseIntentionPatch(corrections) : {};
  await employedRecord(tx, ctx, row.employeeId);
  const snapshots = await checkedSnapshots(tx, ctx, row.employeeId, patch.intendedDate ?? row.intendedDate);
  await saveIntention(
    tx,
    ctx,
    row,
    {
      ...snapshots,
      state: 'in_review',
      ...(patch.intendedDate ? { intendedDate: patch.intendedDate } : {}),
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
    },
    'resubmit',
  );
}
