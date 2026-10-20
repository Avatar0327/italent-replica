/**
 * 兼职“是否部门负责人”“新增下属”联动（docs/08_设计/R2-T05_兼职设计.md §4.8，PT-7，DEC-634）。唯一执行入口：直接新增、编辑、
 * 新增申请审批通过落地都只调 queuePartTimeLinkage，定时生效只调 runDuePartTimeLinkage，到点的判断与改写在 executeLinkage 一处。
 * - 开始日 ≤ 今天：调用方事务内立即执行（严格：任何业务拒绝都向上抛，整单回滚，不留“记录说是负责人、组织上不是”的半套状态）；
 * - 开始日 > 今天：写待执行事件（employment_outbox，不建表），开始日由定时生效执行（宽松：业务拒绝只跳过并留事件，不卡队列）；
 * - 复用调动联动的组织写入（assignTransferOrganizationPeople）与任职编辑（editEmploymentRecord）以及人员资格 / 范围校验
 *   （validateTransferSubordinates），不复用 applyTransferLinkage 入口（它限定 kind = 'transfer'，P-41），也不新增授权项；
 * - 幂等：同一兼职记录至多一条待执行，已有已执行 / 已跳过事件即不再办；组织负责人、下属直线经理已是目标值时不重复写；
 * - 兼职结束、批量结束都不自动撤销负责人 / 下属关系（原站未验证），由 HR 用职责转交处理。
 * 锁序（§7.1）：员工闭包（含下属，UUID 升序）→ 兼职业务头 → 组织设置 / 组织对象 → 下属业务头（闭包取锁时已锁）。
 */
import { sql, type Tx } from '@italent/db';
import {
  PART_TIME_AUDIT_OBJECTS,
  PART_TIME_LINKAGE_EVENTS as EVENTS,
  PART_TIME_LINKAGE_SKIPS as SKIPS,
  tenantLocalDate,
} from '@italent/domain';
import { AppError, ERROR_STATUS } from '../../../errors.js';
import { loadOrgSnapshot } from '../../org/read-model.js';
import { assignTransferOrganizationPeople } from '../../org/write-service.js';
import { auditEmployment } from '../context.js';
import { findCurrentRecord } from '../read-model.js';
import { editEmploymentRecord } from '../record-edit.js';
import { rowsOf } from '../record-store.js';
import { lockTransferParticipants } from '../transfer-locks.js';
import { validateTransferSubordinates } from '../transfer-linkage.js';
import { emptyPresetFields, type EmploymentContext, type PresetFields } from '../types.js';
import { lockPartTimeRecordsById, readPartTimeRecords, type PartTimeRecordRow } from './store.js';

/** 一次联动要办的事：是否设为兼职部门负责人 + 要改直线经理的下属。 */
export interface PartTimeLinkage {
  readonly head: boolean;
  readonly subordinateIds: readonly string[];
}

export type LinkageFields = Pick<PresetFields, 'isDepartmentHead' | 'addedSubordinateIds'>;

/** 保存的联动字段 → 要办的事（false / 空数组都不是联动请求）。 */
export function linkageOf(fields: Partial<LinkageFields>): PartTimeLinkage {
  return { head: fields.isDepartmentHead === true, subordinateIds: fields.addedSubordinateIds ?? [] };
}
export const hasLinkage = (linkage: PartTimeLinkage) => linkage.head || linkage.subordinateIds.length > 0;

/** 编辑里新出现的联动：新设为负责人、新追加的下属（已办过的不再办）。 */
export function linkageDelta(before: Partial<LinkageFields>, after: Partial<LinkageFields>): PartTimeLinkage {
  const had = new Set(before.addedSubordinateIds ?? []);
  return {
    head: after.isDepartmentHead === true && before.isDepartmentHead !== true,
    subordinateIds: (after.addedSubordinateIds ?? []).filter((id) => !had.has(id)),
  };
}

/**
 * 先于员工行锁取整个联动闭包（本人 + 本次输入的下属 + 规划里原有的未办结联动 / 审批中申请的下属，UUID 升序）——创建、编辑、
 * 申请落地、审批同意共用的唯一预锁入口。本次意图只要有联动（负责人或下属）就收齐：编辑只设负责人时，完整意图会连同原待执行的
 * 下属一起办（resolveLinkageIntent），闭包不能只看本次输入（第 2 轮 P2）。没有联动意图就只有调用方既有的员工锁。
 */
export async function lockLinkageParticipants(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  intent: PartTimeLinkage,
): Promise<void> {
  if (hasLinkage(intent)) await lockTransferParticipants(tx, ctx, employeeId, intent.subordinateIds);
}

/** 保存时校验联动人员（沿用调动联动：负责人要有兼职部门的组织写范围；下属须在职、不是本人、在操作人范围内）。 */
export async function validatePartTimeLinkage(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  departmentId: string,
  linkage: PartTimeLinkage,
  asOf: string,
): Promise<void> {
  if (!hasLinkage(linkage)) return;
  await validateTransferSubordinates(
    tx,
    ctx,
    employeeId,
    {
      ...emptyPresetFields(),
      departmentId,
      isDepartmentHead: linkage.head,
      addedSubordinateIds: linkage.subordinateIds.length ? linkage.subordinateIds : null,
    },
    asOf,
  );
}

/** 同一兼职记录是否已办结（已执行或已跳过）/ 是否已有待执行。 */
async function eventExists(tx: Tx, ctx: EmploymentContext, recordId: string, types: readonly string[]) {
  const list = sql.join(
    types.map((type) => sql`${type}`),
    sql`, `,
  );
  return (
    rowsOf(
      await tx.execute(sql`SELECT 1 FROM employment_outbox WHERE tenant_id=${ctx.tenantId}
        AND business_id=${recordId}::uuid AND event_type IN (${list}) LIMIT 1`),
    ).length > 0
  );
}

const scopeOf = (record: PartTimeRecordRow) => ({ employeeId: record.employeeId, orgId: record.departmentId });

async function audit(
  tx: Tx,
  ctx: EmploymentContext,
  action: string,
  record: PartTimeRecordRow,
  after: Record<string, unknown>,
) {
  await auditEmployment(
    tx,
    ctx,
    action,
    PART_TIME_AUDIT_OBJECTS.record,
    record.id,
    null,
    { departmentId: record.departmentId, effectiveDate: record.startDate, ...after },
    undefined,
    undefined,
    scopeOf(record),
  );
}

/** 落地 / 编辑后的统一入口：开始日 ≤ 今天立即严格执行，否则登记待执行（每条记录至多一条）。调用方已持有员工闭包与记录头锁。 */
export async function queuePartTimeLinkage(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  linkage: PartTimeLinkage,
): Promise<void> {
  if (!hasLinkage(linkage)) return;
  const [record] = await readPartTimeRecords(tx, ctx, [recordId]);
  if (!record) throw new AppError('SERVICE_UNAVAILABLE', '兼职记录写入后不可读');
  if (record.startDate > tenantLocalDate(ctx.now, ctx.timezone)) {
    if (!(await eventExists(tx, ctx, recordId, [EVENTS.pending])))
      await audit(tx, ctx, EVENTS.pending, record, linkage.head ? { isDepartmentHead: true } : {});
    return;
  }
  await executeLinkage(tx, ctx, record, await resolveLinkageIntent(tx, ctx, recordId, linkage), { strict: true });
}

/** 业务拒绝（4xx）→ 跳过原因：优先取 details.reason，其次错误码；存储错误（5xx）照常抛，下次运行重试。 */
function skipReason(error: unknown): string | null {
  if (!(error instanceof AppError) || ERROR_STATUS[error.code] >= 500) return null;
  return (error.details as { reason?: string } | undefined)?.reason ?? error.code;
}

async function applyLinkage(tx: Tx, ctx: EmploymentContext, record: PartTimeRecordRow, linkage: PartTimeLinkage) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const departmentId = record.departmentId!;
  await validatePartTimeLinkage(tx, ctx, record.employeeId, departmentId, linkage, today);
  if (linkage.head) {
    const [org] = await loadOrgSnapshot(tx, ctx.tenantId, today, undefined, {
      id: departmentId,
      includeDisabled: true,
    });
    if (org?.personInChargeId !== record.employeeId)
      await assignTransferOrganizationPeople(tx, ctx, departmentId, record.startDate, {
        personInChargeId: record.employeeId,
      });
  }
  for (const id of [...linkage.subordinateIds].sort()) {
    const current = await findCurrentRecord(tx, ctx.tenantId, id, today);
    if (!current) throw new AppError('VALIDATION_FAILED', '新增下属没有当前任职');
    if (current.fields.directManagerId === record.employeeId) continue;
    await editEmploymentRecord(
      tx,
      { ...ctx, expectedRevision: current.revision },
      current.id,
      { fields: { directManagerId: record.employeeId } },
      'api',
      { forwardUpdate: false, linkageDate: record.startDate },
    );
  }
}

/**
 * 到点的判断与改写（立即与定时共用）：兼职已结束 / 不可用 → 跳过并留事件；否则执行并留已执行事件。
 * strict（保存同事务）业务拒绝向上抛；宽松（定时）在保存点内执行，拒绝时整单回滚后只留跳过事件（不留半套）。
 */
async function executeLinkage(
  tx: Tx,
  ctx: EmploymentContext,
  record: PartTimeRecordRow | undefined,
  linkage: PartTimeLinkage,
  options: { readonly strict: boolean },
): Promise<void> {
  if (!record) throw new AppError('SERVICE_UNAVAILABLE', '兼职记录不可读');
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const skip = (reason: string) => audit(tx, ctx, EVENTS.skipped, record, { reason });
  if (!hasLinkage(linkage)) return skip(SKIPS.none);
  if (record.endDate !== null && record.endDate < today) return skip(SKIPS.ended);
  const done = {
    isDepartmentHead: linkage.head,
    addedSubordinateIds: linkage.subordinateIds.length ? linkage.subordinateIds : null,
  };
  if (options.strict) {
    await applyLinkage(tx, ctx, record, linkage);
    return audit(tx, ctx, EVENTS.linked, record, done);
  }
  try {
    await tx.transaction((savepoint) => applyLinkage(savepoint, ctx, record, linkage));
  } catch (error) {
    const reason = skipReason(error);
    if (reason === null) throw error;
    return skip(reason);
  }
  await audit(tx, ctx, EVENTS.linked, record, done);
}

/**
 * 这条兼职此刻要办的完整联动意图（立即落地、编辑、到期调度共用的单一入口；参与者 = 意图里的下属，取锁规划见
 * linkage-participants.ts，所有闭包入口走同一份）。给出 increment（编辑新出现的联动）且没有未办结的待执行联动时，办增量；
 * 否则一律办当前保存的完整意图——开始日已到、调度还没跑时，原待执行的负责人 / 下属还没办，增量不能结清整条待办（第 1 轮 P2-1）。
 */
export async function resolveLinkageIntent(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  increment?: PartTimeLinkage,
): Promise<PartTimeLinkage> {
  const outstanding =
    (await eventExists(tx, ctx, recordId, [EVENTS.pending])) &&
    !(await eventExists(tx, ctx, recordId, [EVENTS.linked, EVENTS.skipped]));
  return increment && !outstanding ? increment : currentLinkage(tx, ctx, recordId);
}

/** 记录当前保存的联动字段（最新载荷版本；编辑追加的快照继承全部字段）。 */
async function currentLinkage(tx: Tx, ctx: EmploymentContext, recordId: string): Promise<PartTimeLinkage> {
  const [row] = rowsOf<{ head: boolean | null; subs: string[] | string | null }>(
    await tx.execute(sql`SELECT is_department_head AS head, added_subordinate_ids AS subs
      FROM employment_payload_versions WHERE tenant_id=${ctx.tenantId} AND business_id=${recordId}::uuid
      ORDER BY version_no DESC LIMIT 1`),
  );
  const subs = typeof row?.subs === 'string' ? row.subs.slice(1, -1).split(',').filter(Boolean) : (row?.subs ?? []);
  return linkageOf({ isDepartmentHead: row?.head ?? null, addedSubordinateIds: subs.length ? subs : null });
}

/**
 * 定时生效（activation-scheduler 在员工事务内调用，闭包锁已由 lockTransferParticipants 取得）：办理这名员工名下开始日已到、
 * 仍未办结的待执行联动。按记录取业务头锁、锁内重读并按当前保存的联动字段执行（待执行后被编辑过也以当前为准）；
 * 重复触发（多实例、重跑）在已办结后直接略过。
 */
export async function runDuePartTimeLinkage(tx: Tx, ctx: EmploymentContext, employeeId: string): Promise<void> {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const due = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT DISTINCT o.business_id::text AS id FROM employment_outbox o
      JOIN employment_records r ON r.tenant_id=o.tenant_id AND r.id=o.business_id
      WHERE o.tenant_id=${ctx.tenantId} AND o.employee_id=${employeeId}::uuid AND o.event_type=${EVENTS.pending}
        AND r.start_date <= ${today}::date AND ${unresolvedSql(sql`o`)}
      ORDER BY 1`),
  );
  if (!due.length) return;
  for (const record of await lockPartTimeRecordsById(
    tx,
    ctx,
    due.map((row) => row.id),
  )) {
    if (await eventExists(tx, ctx, record.id, [EVENTS.linked, EVENTS.skipped])) continue;
    await executeLinkage(tx, ctx, record, await resolveLinkageIntent(tx, ctx, record.id), { strict: false });
  }
}

/** 待执行事件 alias 对应的记录还没有已执行 / 已跳过事件（调度候选、闭包规划共用）。 */
export const unresolvedSql = (pending: ReturnType<typeof sql>) => sql`NOT EXISTS (
  SELECT 1 FROM employment_outbox d WHERE d.tenant_id=${pending}.tenant_id AND d.business_id=${pending}.business_id
    AND d.event_type IN (${EVENTS.linked}, ${EVENTS.skipped}))`;

/** 调度候选：开始日已到、仍有未办结待执行联动的员工（返回 employee_id，按游标分页的一段）。 */
export function dueLinkageEmployees(tenantId: string, businessDate: string) {
  return sql`SELECT DISTINCT o.employee_id::text AS "employeeId" FROM employment_outbox o
    JOIN employment_records r ON r.tenant_id=o.tenant_id AND r.id=o.business_id
    WHERE o.tenant_id=${tenantId} AND o.event_type=${EVENTS.pending} AND r.start_date <= ${businessDate}::date
      AND ${unresolvedSql(sql`o`)}`;
}
