/**
 * 待入职的状态动作（R2 BE-2a；docs/02_业务建模/34 EN-R8 / R9 / R14，DEC-484② / DEC-540 保守口径）：
 * 取消入职、改期入职、编辑待入职（F-188）、删除待入职。只做 F-129 已核实的状态变化，不联动信息采集；
 * Offer 联动只留端口（F-192a，entry-offer-hooks.ts，BE-14 接）：取消 / 已取消恢复出站通知，Offer 拒绝入站取消；
 * 待入职合同（F-194）：改期入职同步合同起始日，编辑不联动，删除一并清理，取消保留供恢复时改期联动。
 * 办理入职复用 employee-status.ts 的 completePendingEntry（其内含 DEC-138 / 139 校验）。
 */
import { sql, type Tx } from '@italent/db';
import {
  ENTRY_STATUS,
  ENTRY_REMARK_MAX,
  type EntryAction,
  type EntryCancelReason,
  type EntryEditEmployType,
  type EntryStatusCode,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { auditEmployment } from './context.js';
import { entryOfferHooks } from './entry-offer-hooks.js';
import { changePendingEntryStatus, lockPendingEntry } from './employee-status.js';
import { businessDate } from './fields.js';
import {
  clearPendingContract,
  loadPendingContract,
  pendingContractAudit,
  releasePendingContract,
  type PendingContract,
  type PendingContractNotice,
} from './entry-pending-contract.js';
import { loadPendingProbation, loadPendingProbationState, savePendingProbation } from './entry-probation.js';
import { bumpEmploymentBusiness, lockEmploymentEmployee, type LockedEmploymentBusiness } from './record-store.js';
import { transitionEmployment } from './transitions.js';
import type { EmploymentBusiness, EmploymentContext, EmploymentRecord } from './types.js';
import { appendEmployee, employeeSnapshot } from '../personnel/employee-write.js';
import { createEmploymentBusiness, requireSavedBusiness } from './write-service.js';

interface EntryActionLog {
  readonly employeeId: string;
  readonly businessId: string;
  readonly previousBusinessId?: string;
  readonly action: EntryAction;
  readonly reason?: EntryCancelReason;
  readonly remark?: string;
  readonly fromDate?: string;
  readonly toDate?: string;
}

function assertRemark(remark: string | undefined) {
  if (remark !== undefined && remark.length > ENTRY_REMARK_MAX)
    throw new AppError('VALIDATION_FAILED', `备注不能超过 ${ENTRY_REMARK_MAX} 字`);
}

async function logEntryAction(tx: Tx, ctx: EmploymentContext, log: EntryActionLog): Promise<void> {
  await tx.execute(sql`INSERT INTO employment_entry_actions(tenant_id, employee_id, business_id, previous_business_id,
      action, reason_code, remark, from_date, to_date, command_id, actor_user_id, created_at)
    VALUES (${ctx.tenantId}, ${log.employeeId}::uuid, ${log.businessId}::uuid, ${log.previousBusinessId ?? null}::uuid,
      ${log.action}, ${log.reason ?? null}, ${log.remark ?? null}, ${log.fromDate ?? null}::date,
      ${log.toDate ?? null}::date, ${ctx.commandId}, ${ctx.userId}::uuid, ${ctx.now.toISOString()}::timestamptz)`);
}

interface CancelInput {
  readonly reason?: EntryCancelReason;
  readonly remark?: string;
}

/** 不传原因时的默认值（R2e9 原站：下拉默认“其他原因”）。 */
const DEFAULT_CANCEL_REASON: EntryCancelReason = 'other';

/**
 * 取消的共同内核：状态 → 取消、动作日志、审计（含原因）同事务。
 * 路由入口重复取消是冲突（409）；Offer 入站端口保持幂等：已取消直接返回，不重复写日志。
 */
async function cancelEntryCore(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  input: CancelInput,
  mode: { readonly rejectUnchanged: boolean },
): Promise<{ readonly record: EmploymentRecord; readonly changed: boolean }> {
  assertRemark(input.remark);
  const { record: before } = await lockPendingEntry(tx, ctx, recordId);
  if (!mode.rejectUnchanged && before.entryStatus === ENTRY_STATUS.cancelled) return { record: before, changed: false };
  const reason = input.reason ?? DEFAULT_CANCEL_REASON;
  const record = await changePendingEntryStatus(tx, ctx, recordId, 'cancelled', mode);
  await logEntryAction(tx, ctx, {
    employeeId: record.employeeId,
    businessId: recordId,
    action: 'cancel',
    reason,
    remark: input.remark,
  });
  await auditEmployment(
    tx,
    ctx,
    'employment.entry.cancel',
    'employment-business',
    recordId,
    { entryStatus: before.entryStatus },
    { entryStatus: record.entryStatus, reason, remark: input.remark ?? null },
  );
  return { record, changed: true };
}

/**
 * 取消入职（EN-R9）：入职状态 = 取消，进“已取消入职”；原因（5 项）与说明非必填，不传原因记为“其他原因”（F-192a）；重复取消 409。
 * 同事务通知 Offer 联动端口（BE-14 把 Offer 改为已拒绝）；端口抛错整笔回滚。无二次确认是前端的事。
 */
export async function cancelPendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  input: CancelInput,
): Promise<EmploymentBusiness> {
  await entryOfferHooks.beforeAction(tx, ctx, { businessId: recordId });
  const { record } = await cancelEntryCore(tx, ctx, recordId, input, { rejectUnchanged: true });
  await entryOfferHooks.entryCancelled(tx, ctx, { employeeId: record.employeeId, businessId: recordId });
  return requireSavedBusiness(tx, ctx, recordId);
}

/**
 * 入站端口（交 BE-14）：Offer 侧“拒绝已接受的 Offer”自动取消入职（R2e9），原因 / 备注为拒绝 Offer 时所选。
 * 复用取消内核，但**不回调 onEntryCancelled**（Offer 已是已拒绝，避免循环）；已取消则幂等返回；
 * 已办理入职的记录拒绝（NOT_PENDING_ENTRY）。失效 Offer 删除待入职走 deletePendingEntry，不进已取消。
 */
export async function cancelPendingEntryForOfferRefusal(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  input: CancelInput,
): Promise<EmploymentBusiness> {
  await cancelEntryCore(tx, ctx, recordId, input, { rejectUnchanged: false });
  return requireSavedBusiness(tx, ctx, recordId);
}

interface ReplaceInput {
  readonly action: 'postpone' | 'edit';
  readonly effectiveDate: string;
  readonly entryStatus: EntryStatusCode;
  /** 新的试用期；不传 = 沿用原值（改期入职只搬运，不改）。 */
  readonly probation?: boolean;
  readonly employType?: EntryEditEmployType;
  readonly remark?: string;
  /** 改期入职（原站验证）把待入职合同起始日改成新日期；编辑换日期不联动，合同原样搬到新记录（F-194）。 */
  readonly syncContract: boolean;
  /** Offer 编辑并同步（OF-R14）：整份替换任职字段 / 试用期月数 / 待入职合同（缺省沿用原记录上的值）。 */
  readonly offer?: {
    readonly fields: EmploymentRecord['fields'];
    readonly probationMonths: number | null;
    readonly contract: PendingContract;
  };
}

interface ReplacedEntry {
  readonly business: EmploymentBusiness;
  /** 搬运 / 联动后新记录上的合同；原记录没有合同（存量）为 null。 */
  readonly contract: PendingContract | null;
}

/**
 * 改期 / 编辑换日期的共同内核：任职记录的生效日 / 入职日不可原地改（只追加版本链，AGENTS §2），所以 = 删除原待入职记录
 * 并按新日期、原业务类型 / 表单标识 / 字段重建（同事务）；记录 ID 随之变化，两条用日志的 previous_business_id 串起，
 * 待入职试用期（F-188）、待入职合同（F-194）搬到新记录。后面还有任职记录或在途申请时，删除一步按既有口径拒绝，整笔回滚。
 * 重建后的入职状态由调用方定：改期恒为延期，编辑保持原值。
 *
 * 不联动 Offer（R2e8 / DEC-546）：编辑 / 改期不回写 Offer 拟入职日期；手动删除待入职不改 Offer 状态。BE-14 接 Offer 时遵守。
 */
async function replacePendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  locked: { readonly business: LockedEmploymentBusiness; readonly record: EmploymentRecord },
  input: ReplaceInput,
): Promise<ReplacedEntry> {
  const { business, record } = locked;
  const previousState = await loadPendingProbationState(tx, ctx, record.id);
  const previousProbation = previousState?.probation ?? null;
  const probation = input.probation ?? previousProbation;
  // Offer 同步带来的月数随记录搬运（试用期改为无时月数自然清空）
  const probationMonths = probation ? (input.offer?.probationMonths ?? previousState?.months ?? undefined) : undefined;
  const previousContract = await loadPendingContract(tx, ctx, record.id);
  const contract =
    input.offer?.contract ??
    (previousContract && input.syncContract
      ? { ...previousContract, startDate: input.effectiveDate }
      : previousContract);
  await transitionEmployment(tx, ctx, { id: record.id, action: 'delete' });
  await clearPendingContract(tx, ctx, record.id);
  const employee = await lockEmploymentEmployee(tx, ctx, record.employeeId);
  const created = await createEmploymentBusiness(
    tx,
    { ...ctx, expectedRevision: employee.revision },
    record.employeeId,
    {
      // 保留原业务类型（hire / rehire / retire_rehire）与表单标识：重聘、返聘改期后仍是重聘、返聘
      kind: record.kind,
      mode: 'direct',
      formId: business.payload.formId,
      effectiveDate: input.effectiveDate,
      fields:
        (input.offer ?? input.employType)
          ? { ...(input.offer?.fields ?? record.fields), ...(input.employType ? { employType: input.employType } : {}) }
          : record.fields,
      customFields: record.customFields,
    },
    {
      entry: {
        pendingEntry: true,
        entryStatus: input.entryStatus,
        ...(probation === null ? {} : { probation }),
        ...(probationMonths === undefined ? {} : { probationMonths }),
        pendingContract: contract,
      },
    },
  );
  await logEntryAction(tx, ctx, {
    employeeId: record.employeeId,
    businessId: created.id,
    previousBusinessId: record.id,
    action: input.action,
    remark: input.remark,
    fromDate: record.effectiveDate,
    toDate: input.effectiveDate,
  });
  await auditEmployment(
    tx,
    ctx,
    `employment.entry.${input.action}`,
    'employment-business',
    created.id,
    {
      businessId: record.id,
      effectiveDate: record.effectiveDate,
      entryStatus: record.entryStatus,
      probation: previousProbation,
      ...pendingContractAudit(previousContract),
      ...(input.employType ? { employType: record.fields.employType } : {}),
    },
    {
      businessId: created.id,
      effectiveDate: input.effectiveDate,
      entryStatus: input.entryStatus,
      probation,
      ...pendingContractAudit(contract),
      ...(input.employType ? { employType: input.employType } : {}),
    },
  );
  return { business: created, contract };
}

/**
 * 改期入职（EN-R8）：入职日期必填、备注可选，入职状态变“延期”；已取消入职改期即恢复。
 * 同事务把待入职合同起始日改成新日期（F-194，DEC-550）。
 */
export async function postponePendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  input: { readonly effectiveDate: string; readonly remark?: string },
): Promise<EmploymentBusiness & { readonly contractNotice: PendingContractNotice | null }> {
  assertRemark(input.remark);
  const effectiveDate = businessDate(input.effectiveDate);
  await entryOfferHooks.beforeAction(tx, ctx, { businessId: recordId });
  const locked = await lockPendingEntry(tx, ctx, recordId);
  if (effectiveDate === locked.record.effectiveDate && locked.record.entryStatus !== ENTRY_STATUS.cancelled)
    throw new AppError('VALIDATION_FAILED', '改期后的入职日期不能与原入职日期相同', { reason: 'ENTRY_DATE_UNCHANGED' });
  const wasCancelled = locked.record.entryStatus === ENTRY_STATUS.cancelled;
  const { business, contract } = await replacePendingEntry(tx, ctx, locked, {
    action: 'postpone',
    effectiveDate,
    entryStatus: ENTRY_STATUS.postponed,
    remark: input.remark,
    syncContract: true,
  });
  // 已取消经改期恢复：通知 Offer 联动端口回到已接受；不传日期，Offer 拟入职日期保持原值（F-192a / DEC-546）
  if (wasCancelled)
    await entryOfferHooks.entryRestored(tx, ctx, {
      employeeId: locked.record.employeeId,
      businessId: business.id,
      previousBusinessId: recordId,
    });
  // 前端据此提示“待入职记录中劳动合同起止日期改为YYYY/MM/DD-”；存量待入职没有合同则不提示
  return { ...business, contractNotice: contract && { startDate: contract.startDate, endDate: contract.endDate } };
}

/**
 * 编辑待入职（F-188，DEC-546② R2e8 行内“编辑”；R2e9 起可改雇佣关系）：计划入职日期（允许过去日期）+ 是否有试用期（必填）
 * + 雇佣关系（可选，内部员工 / 实习生，不传不改）。入职状态保持原值（正常 / 延期 / 取消都不变，与改期入职变“延期”不同）。
 * 日期和雇佣关系都没变：只更新试用期（记录 ID 不变，revision +1，不写动作日志，字段级审计记变更）；
 * 日期或雇佣关系变了：任职记录不可原地改这两项，走替换内核。其他任职字段仍走 PATCH /records/:id。
 * 合同起止日期不联动（F-194，DEC-550）：日期变了合同原样搬到新记录，响应不带 contractNotice。
 */
export async function editPendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  input: { readonly effectiveDate: string; readonly probation: boolean; readonly employType?: EntryEditEmployType },
): Promise<EmploymentBusiness> {
  const effectiveDate = businessDate(input.effectiveDate);
  const locked = await lockPendingEntry(tx, ctx, recordId);
  const { business, record } = locked;
  const entryStatus = record.entryStatus ?? ENTRY_STATUS.normal;
  const employType =
    input.employType !== undefined && input.employType !== record.fields.employType ? input.employType : undefined;
  if (effectiveDate !== record.effectiveDate || employType !== undefined)
    return (
      await replacePendingEntry(tx, ctx, locked, {
        action: 'edit',
        effectiveDate,
        entryStatus,
        probation: input.probation,
        employType,
        syncContract: false,
      })
    ).business;
  const before = await loadPendingProbation(tx, ctx, recordId);
  await savePendingProbation(tx, ctx, record.employeeId, recordId, input.probation);
  await bumpEmploymentBusiness(tx, ctx, business);
  await auditEmployment(
    tx,
    ctx,
    'employment.entry.edit',
    'employment-business',
    recordId,
    { probation: before },
    {
      probation: input.probation,
    },
  );
  return requireSavedBusiness(tx, ctx, recordId);
}

/**
 * 删除待入职（EN-R14，不可恢复）：只删待入职记录本身，已入职记录一律拒绝（NOT_PENDING_ENTRY）；人员主档保留（DEC-540）。
 * 同一内核也是“Offer 失效时删除待入职”的领域端口（F-171 / DEC-529，由 BE-14 在 Offer 侧调用）。
 * 手动删除待入职不改 Offer 状态（R2e8 / DEC-546），BE-14 不得因此回写 Offer。
 */
export async function deletePendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
): Promise<EmploymentBusiness> {
  await lockPendingEntry(tx, ctx, recordId);
  const deleted = await transitionEmployment(tx, ctx, { id: recordId, action: 'delete' });
  await releasePendingContract(tx, ctx, recordId, 'delete');
  return deleted;
}

export interface OfferEntryChange {
  readonly effectiveDate: string;
  /** Offer 有值的任职字段（OF-R1 映射）；没填的项不覆盖目标上已有的值。 */
  readonly fields: Readonly<Record<string, string>>;
  readonly probation: boolean | null;
  readonly probationMonths: number | null;
  readonly contract: PendingContract;
  /** Offer 有值的员工信息（姓名 / 邮箱 / 手机 / 证件等，OF-R1 映射）。 */
  readonly profile: Readonly<Record<string, string>>;
  /** 业务预校验：目标核验和差异计算之后、任何写入之前调用，抛业务错误即整笔不写。 */
  readonly validate?: () => void;
}

export type OfferEntryPush = 'cancelled' | 'unchanged' | 'pushed';

const sameValue = (a: unknown, b: unknown) =>
  (a instanceof Date ? a.toISOString().slice(0, 10) : String(a ?? '')) ===
  (b instanceof Date ? b.toISOString().slice(0, 10) : String(b ?? ''));

/**
 * 入站端口（Offer 编辑并同步，OF-R14）：Offer 往待入职推送的**唯一**入口（DEC-431①）。固定顺序——
 * 1. 锁内核验目标确为未取消的待入职（员工 / 业务头锁在 lockPendingEntry），已取消返回 'cancelled'，整笔不写；
 * 2. 以目标当前快照（员工资料版本 / 任职记录 / 试用期 / 待入职合同）和 Offer 当前值算差异，不拿 Offer 上一版当“已同步快照”，
 *    所以失败重试、先“否”后“是”都不会遗漏；没有任何差异返回 'unchanged'（不白追加版本、不白换记录 ID）；
 * 3. 调用方给的业务预校验（合同日期等）；
 * 4. 写入：员工资料有差异追加一个员工版本；任职 / 试用期 / 合同有差异走替换内核（任职记录不可原地改日期和字段，同事务删旧建新，
 *    ID 随之变，动作日志串起新旧，Offer 沿链找最新；入职状态保持原值，与行内编辑同口径）。
 * Offer 行锁由调用方先取（锁序 Offer → 员工 → 业务）。
 */
export async function pushOfferToPendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  change: OfferEntryChange,
): Promise<OfferEntryPush> {
  const locked = await lockPendingEntry(tx, ctx, recordId);
  const { record } = locked;
  if (record.entryStatus === ENTRY_STATUS.cancelled) return 'cancelled';
  const person = await employeeSnapshot(tx, { ...ctx, expectedRevision: 0 }, record.employeeId);
  const profile = Object.fromEntries(
    Object.entries(change.profile).filter(([key, value]) => !sameValue(person?.[key], value)),
  );
  const state = await loadPendingProbationState(tx, ctx, record.id);
  const contract = await loadPendingContract(tx, ctx, record.id);
  const recordSame =
    sameValue(record.effectiveDate, change.effectiveDate) &&
    Object.entries(change.fields).every(([key, value]) =>
      sameValue(record.fields[key as keyof typeof record.fields], value),
    ) &&
    (change.probation === null || (state?.probation ?? null) === change.probation) &&
    (!change.probation || (state?.months ?? null) === change.probationMonths) &&
    sameValue(contract?.startDate, change.contract.startDate) &&
    sameValue(contract?.endDate, change.contract.endDate) &&
    sameValue(contract?.companyId, change.contract.companyId);
  if (!Object.keys(profile).length && recordSame) return 'unchanged';
  change.validate?.();
  if (Object.keys(profile).length)
    await appendEmployee(tx, { ...ctx, expectedRevision: 0 }, record.employeeId, profile, false);
  if (!recordSame)
    await replacePendingEntry(tx, ctx, locked, {
      action: 'edit',
      effectiveDate: change.effectiveDate,
      entryStatus: record.entryStatus ?? ENTRY_STATUS.normal,
      ...(change.probation === null ? {} : { probation: change.probation }),
      remark: 'Offer 编辑并同步',
      syncContract: false,
      offer: {
        fields: { ...record.fields, ...change.fields },
        probationMonths: change.probationMonths,
        contract: change.contract,
      },
    });
  return 'pushed';
}
