/**
 * Offer → 待入职同步（R2 BE-14b2；docs/02_业务建模/34 OF-R1 / R8 / R10、文末“Offer → 待入职的字段映射”）。
 * 同步 = 建人员档案 + 绑定租户用户 + 经 createEmploymentBusiness 的 pendingEntry 通道生成待入职（含待入职合同、是否有试用期）。
 * 同步在保存点里执行：业务规则拒绝（严格控编超编、黑名单、账号冲突等）回滚保存点、把原因记在 Offer 上
 * （sync_status = failed），不影响“接受”本身（AC-OF-06）；存储不可用等非业务错误原样抛出，由调用方整笔回滚、下次重试。
 * 重复同步幂等：已关联待入职直接返回；Offer 行锁串行化并发同步，恰好一条待入职。
 *
 * 入站调用（F-201②）：对 employment 的调用都带显式的受控上下文（inboundEmploymentContext：当前租户 / 操作人 / 时间 / 命令，
 * 员工 revision 取锁内当前值，范围显式给“系统全量”并写明原因），不靠省略范围；调用方（立即同步 / 夜间任务）的权限在
 * 入口按 Offer 对象与 Offer 自己的数据范围判定，招聘专员没有人员范围也能同步自己范围内的 Offer。
 */
import { and, eq, offers, type Tx } from '@italent/db';
import {
  EMPLOYEE_STATUS,
  effectiveOfferType,
  MODULE_OBJECTS,
  OFFER_SYNC_DEFAULT,
  OFFER_SYNC_TIMING_KEY,
  PROBATION_MONTHS_MAX,
  PROBATION_MONTHS_MIN,
  offerManualSyncable,
  offerSyncDue,
  offerSyncKind,
  tenantLocalDate,
  validOfferSyncSetting,
  type OfferSyncSetting,
  type OfferType,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { createEmployee } from '../employment/employees.js';
import { ruleRejection } from '../employment/activation-checks.js';
import { findPredecessor } from '../employment/read-model.js';
import { lockEmploymentEmployee } from '../employment/record-store.js';
import { visibleEmploymentRecords } from '../employment/visibility.js';
import { createEmploymentBusiness } from '../employment/write-service.js';
import { regularizeIntern } from '../employment/intern-regularization.js';
import { appendEmployee } from '../personnel/employee-write.js';
import { provisionEmployeeUser } from '../permission/user-provisioning.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { assertOfferRevision, type OfferContext } from './context.js';
import { findOfferByPendingEntry } from './entry-link.js';
import { audit, lockOffer, offerDto, type OfferRow } from './service.js';
import { assertNoStrictQuota } from './establishment.js';
import { inboundEmploymentContext, lockOfferSyncScope, type OfferSyncContext } from './sync-lock.js';

export type { OfferSyncContext };

export { findOfferByPendingEntry };

export async function readOfferSyncSetting(tx: Tx, tenantId: string): Promise<OfferSyncSetting> {
  const value = (await readEffectiveSetting(tx, tenantId, OFFER_SYNC_TIMING_KEY)).value;
  return validOfferSyncSetting(value) ? value : OFFER_SYNC_DEFAULT;
}

interface LinkedPerson {
  readonly employeeId: string;
  /** 最近一条任职不是离职 / 退休（在职实习生）。 */
  readonly active: boolean;
}

/** 关联的实习生：必须是实习生（最近一条任职的雇佣关系），且不是待入职。 */
async function linkedPerson(tx: Tx, tenantId: string, employeeId: string): Promise<LinkedPerson | null> {
  const latest = await findPredecessor(tx, tenantId, employeeId, '9999-12-31');
  if (!latest || latest.fields.employType !== 'intern' || latest.employeeStatus === EMPLOYEE_STATUS.pendingEntry)
    return null;
  return { employeeId, active: !['leave', 'retirement'].includes(latest.kind) };
}

export const present = (values: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined));

/** 人员信息（34 文末映射：姓名 / 邮箱 / 手机 / 性别 / 证件 / 出生日期）；Offer 没填的项不覆盖已有档案。 */
export function profilePatch(offer: OfferRow) {
  return present({
    name: offer.name,
    email: offer.personalEmail,
    mobilePhone: offer.mobile,
    gender: offer.gender,
    idType: offer.idType,
    idNumber: offer.idNumber,
    birthday: offer.birthDate,
  });
}

type SyncPlan = 'hire' | 'rehire' | 'retire_rehire' | 'intern_regularization';

/**
 * 同步产物按计划入职日的任职版本链决定（任职记录不可绕过顺序规则，07 §2、DEC-077）：
 * 没有任职 → 入职；前一条是离职 / 退休 → 重聘 / 返聘（已离职实习生走这条，不受在职实习生开关限制）；
 * 前一条是在职实习生 → 实习转正（IN-R3 正式 Offer 是实习转正的方式之一，IN-R4 新增一条“实习转正”任职记录）。
 */
async function syncPlan(
  tx: Tx,
  ctx: OfferSyncContext,
  employeeId: string,
  plannedEntryDate: string,
): Promise<SyncPlan> {
  const latest = await findPredecessor(tx, ctx.tenantId, employeeId, plannedEntryDate);
  if (!latest) return 'hire';
  if (latest.kind === 'leave') return 'rehire';
  if (latest.kind === 'retirement') return 'retire_rehire';
  return latest.fields.employType === 'intern' ? 'intern_regularization' : 'hire';
}

/** 实习转正的试用期（月）取值范围与实习转正表单一致（1～6）；Offer 上更宽的取值在这里按业务规则拒绝。 */
function regularizationProbation(offer: OfferRow) {
  const probation = offer.hasProbation === true;
  const months = offer.probationMonths;
  if (probation && (months === null || months < PROBATION_MONTHS_MIN || months > PROBATION_MONTHS_MAX))
    throw new AppError('VALIDATION_FAILED', '实习转正的试用期（月）须在 1～6 之间', {
      reason: 'OFFER_PROBATION_MONTHS_INVALID',
    });
  return probation ? { probation, probationMonths: months! } : { probation };
}

/** 合同终止日不得早于计划入职日（同步待入职与编辑并同步共用的业务校验；待入职合同表另有同口径的 CHECK 作兜底）。 */
export function assertContractDates(offer: Pick<OfferRow, 'contractEndDate' | 'plannedEntryDate'>) {
  if (offer.contractEndDate && offer.plannedEntryDate && offer.contractEndDate < offer.plannedEntryDate)
    throw new AppError('VALIDATION_FAILED', '合同终止日期不能早于计划入职日期', {
      reason: 'OFFER_CONTRACT_DATE_INVALID',
    });
}

/** 创建 / 复用人员、绑定用户、生成同步产物；返回记录 ID 与产物类型。整个过程在调用方给的保存点里。 */
async function createSyncTarget(tx: Tx, ctx: OfferSyncContext, offer: OfferRow, linked: LinkedPerson | null) {
  const base = inboundEmploymentContext(ctx, 0);
  const kind = offerSyncKind(offer.offerType as OfferType | null);
  assertContractDates(offer);
  // 工号由 Offer ID 派生（同一 Offer 重试不会再造人）；入职准备里的“分配工号”之后再改
  const employeeId =
    linked?.employeeId ?? (await createEmployee(tx, base, { code: `OFR-${offer.id}`, name: offer.name! })).id;
  await appendEmployee(tx, { ...ctx, expectedRevision: 0 }, employeeId, profilePatch(offer), false);
  // DEC-128 / DEC-140：入职类业务同事务绑定租户用户，登录邮箱取 Offer 的个人邮箱；已绑定的人员不改绑（邮箱不同即冲突）
  await provisionEmployeeUser(tx, ctx, {
    employeeId,
    loginEmail: offer.personalEmail!,
    displayName: offer.name!,
    accountRequired: true,
  });
  const employee = await lockEmploymentEmployee(tx, base, employeeId);
  const employment = inboundEmploymentContext(ctx, employee.revision);
  const plan = await syncPlan(tx, ctx, employeeId, offer.plannedEntryDate!);
  // 生产的编制入口对 hire / rehire 不判容量，确认标记（弱控）也只在发送 / 接受时管弱控：同步在锁内自己做真实强控检查，
  // 超编按严格控制拒绝（记同步失败 ESTABLISHMENT_EXCEEDED）；实习转正走编制入口自己的强控，不重复判
  if (plan !== 'intern_regularization') await assertNoStrictQuota(tx, employment, offer, employeeId);
  const references = present({
    positionId: offer.positionId,
    directManagerId: offer.directManagerId,
    dottedManagerId: offer.dottedManagerId,
  });
  if (plan === 'intern_regularization') {
    // 实习转正只适用于正式 Offer（IN-R3）：实习 Offer 不得追加实习转正记录、不得把实习生改成内部员工
    if (effectiveOfferType(offer.offerType as OfferType | null) === 'intern')
      throw new AppError('VALIDATION_FAILED', '实习 Offer 不是正式 Offer，不能把在职实习生转正', {
        reason: 'OFFER_INTERN_OFFER_CONVERSION',
      });
    // 弱控确认归 b1：同步不弹确认（confirmed），严格控编超编仍由落地时整单拒绝（ESTABLISHMENT_EXCEEDED）
    const business = await regularizeIntern(tx, employment, employeeId, {
      effectiveDate: offer.plannedEntryDate!,
      departmentId: offer.departmentId!,
      ...references,
      ...regularizationProbation(offer),
      confirmed: true,
    });
    return { id: business.id, target: 'intern_regularization' as const };
  }
  const business = await createEmploymentBusiness(
    tx,
    employment,
    employeeId,
    {
      kind: plan,
      mode: 'direct',
      effectiveDate: offer.plannedEntryDate!,
      fields: present({
        employType: kind.employType,
        departmentId: offer.departmentId,
        postId: offer.postId,
        levelId: offer.levelId,
        place: offer.workPlace,
        ...references,
      }),
    },
    {
      entry: {
        pendingEntry: true,
        ...(offer.hasProbation === null ? {} : { probation: offer.hasProbation }),
        ...(offer.hasProbation && offer.probationMonths !== null ? { probationMonths: offer.probationMonths } : {}),
        // 合同公司（甲方）= Offer 的合同主体法人公司（34 文末映射）；起止日 = 计划入职日 ~ Offer 合同终止日
        pendingContract: {
          startDate: offer.plannedEntryDate!,
          endDate: offer.contractEndDate,
          companyId: offer.contractCompanyId,
        },
      },
    },
  );
  return { id: business.id, target: 'pending_entry' as const };
}

export async function saveSync(
  tx: Tx,
  ctx: OfferSyncContext,
  before: OfferRow,
  patch: Partial<OfferRow>,
  action: string,
) {
  const [after] = await tx
    .update(offers)
    .set({
      ...patch,
      syncAttempts: before.syncAttempts + 1,
      lastSyncAt: ctx.now,
      revision: before.revision + 1,
      updatedAt: ctx.now,
    })
    .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, before.id)))
    .returning();
  await audit(tx, ctx, action, before.id, before, after!);
  return after!;
}

/**
 * 同步一条 Offer（调用方已按 Offer 行锁加锁并核对状态 / 时机）。已关联待入职：幂等返回原行。
 * 业务规则拒绝记为同步失败（次数 +1、机读原因与说明落列）；其他错误原样抛出。
 */
export async function syncOffer(tx: Tx, ctx: OfferSyncContext, offer: OfferRow): Promise<OfferRow> {
  if (offer.pendingEntryBusinessId !== null) return offer;
  // 取锁单一入口（sync-lock.ts）：Offer → 员工 → 业务头 → 组织 / 编制；关联已有人员时先于任何编制判定取齐
  await lockOfferSyncScope(tx, ctx, offer);
  const linked = offer.linkedEmployeeId ? await linkedPerson(tx, ctx.tenantId, offer.linkedEmployeeId) : null;
  try {
    const created = await tx.transaction((savepoint) => createSyncTarget(savepoint, ctx, offer, linked));
    return await saveSync(
      tx,
      ctx,
      offer,
      {
        pendingEntryBusinessId: created.id,
        syncTarget: created.target,
        syncStatus: 'success',
        syncReason: null,
        syncMessage: null,
        syncedAt: ctx.now,
      },
      'sync',
    );
  } catch (error) {
    const failure = ruleRejection(error);
    if (!failure) throw error;
    const { code, message, rule } = failure.detail as { code: string; message: string; rule: string | null };
    return await saveSync(
      tx,
      ctx,
      offer,
      { syncStatus: 'failed', syncReason: rule ?? code, syncMessage: message },
      'sync_failed',
    );
  }
}

/** 在职实习生的正式 Offer 且开关关闭：不同步，改走实习转正（OF-R8）。 */
async function internConversionOnly(tx: Tx, ctx: OfferSyncContext, offer: OfferRow, setting: OfferSyncSetting) {
  if (setting.internConversion || !offer.linkedEmployeeId) return false;
  return (await linkedPerson(tx, ctx.tenantId, offer.linkedEmployeeId))?.active === true;
}

/** 立即同步（手动）：状态守卫 → 版本 → 在职实习生开关 → 同步。已同步的重复点击幂等，不动 revision。 */
export async function syncOfferNow(tx: Tx, ctx: OfferContext, id: string) {
  const row = await lockOffer(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, row.revision);
  if (row.pendingEntryBusinessId !== null) return offerDto(row);
  const setting = await readOfferSyncSetting(tx, ctx.tenantId);
  if (!offerManualSyncable(setting, row.status as never))
    throw new AppError('CONFLICT', '只有已接受（或同步时机为发送时的已发）Offer 可以同步待入职', {
      reason: 'OFFER_SYNC_STATE_INVALID',
    });
  if (await internConversionOnly(tx, ctx, row, setting))
    throw new AppError('CONFLICT', '在职实习生的 Offer 同步已关闭，请走实习转正', {
      reason: 'OFFER_SYNC_INTERN_CONVERSION',
    });
  return offerDto(await syncOffer(tx, ctx, row));
}

/**
 * 到期则自动同步（接受 / 发送后的当场触发与夜间任务共用）：加锁重读、按时机判定；没到期、在职实习生开关关闭、已同步都原样返回。
 * 返回是否本次发起了同步，以及同步后的行。
 */
export async function syncOfferWhenDue(
  tx: Tx,
  ctx: OfferSyncContext,
  id: string,
  options: { skipLocked?: boolean } = {},
) {
  const query = tx
    .select()
    .from(offers)
    .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, id)));
  const [row] = await (options.skipLocked ? query.for('update', { skipLocked: true }) : query.for('update'));
  if (!row || row.pendingEntryBusinessId !== null) return { attempted: false, row: row ?? null };
  const setting = await readOfferSyncSetting(tx, ctx.tenantId);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  if (!offerSyncDue(setting, row, today) || (await internConversionOnly(tx, ctx, row, setting)))
    return { attempted: false, row };
  return { attempted: true, row: await syncOffer(tx, ctx, row) };
}

/** 关联 / 解除关联在职实习生（OF-R8）：待发、已发可改；对象必须是实习生且在当前人员范围内。 */
export async function linkEmployee(tx: Tx, ctx: OfferContext, id: string, employeeId: string | null) {
  const before = await lockOffer(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, before.revision);
  if (before.status !== 'pending' && before.status !== 'sent')
    throw new AppError('CONFLICT', '只有待发或已发的 Offer 可以关联在职实习生', { reason: 'OFFER_LINK_NOT_ALLOWED' });
  if (employeeId !== null) {
    // IN-R3：实习转正的“正式 Offer”才关联在职实习生；实习 Offer（新建实习生 / 校招生提前实习）不适用
    if (effectiveOfferType(before.offerType as OfferType | null) === 'intern')
      throw new AppError('VALIDATION_FAILED', '实习 Offer 不能关联在职实习生', { reason: 'OFFER_LINK_TYPE_INVALID' });
    const scope = await ctx.scopeOf!(MODULE_OBJECTS.employee.code);
    const target = { employeeId, departmentId: null, creatorId: null };
    const invalid = new AppError('VALIDATION_FAILED', 'Offer 引用的对象不存在', { reason: 'OFFER_REFERENCE_INVALID' });
    if ((await visibleEmploymentRecords(tx, ctx.tenantId, scope, [target])).includes(false)) throw invalid;
    if (!(await linkedPerson(tx, ctx.tenantId, employeeId)))
      throw new AppError('VALIDATION_FAILED', '只能关联实习生', { reason: 'OFFER_LINK_NOT_INTERN' });
  }
  const [after] = await tx
    .update(offers)
    .set({ linkedEmployeeId: employeeId, revision: before.revision + 1, updatedAt: ctx.now })
    .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, id)))
    .returning();
  await audit(tx, ctx, 'link_employee', id, before, after!);
  return offerDto(after!);
}
