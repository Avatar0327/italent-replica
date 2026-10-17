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
  MODULE_OBJECTS,
  OFFER_SYNC_DEFAULT,
  OFFER_SYNC_TIMING_KEY,
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
import type { EntryOfferHooks } from '../employment/entry-offer-hooks.js';
import { findPredecessor } from '../employment/read-model.js';
import { lockEmploymentEmployee } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { visibleEmploymentRecords } from '../employment/visibility.js';
import { createEmploymentBusiness } from '../employment/write-service.js';
import { appendEmployee } from '../personnel/employee-write.js';
import { provisionEmployeeUser } from '../permission/user-provisioning.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { assertOfferRevision, type OfferContext } from './context.js';
import { findOfferByPendingEntry } from './entry-link.js';
import { audit, lockOffer, offerDto, type OfferRow } from './service.js';

export { findOfferByPendingEntry };

/** 同步需要的上下文子集：立即同步取自请求，夜间任务由系统构造。 */
export type OfferSyncContext = Pick<OfferContext, 'tenantId' | 'userId' | 'timezone' | 'now' | 'commandId'>;

export async function readOfferSyncSetting(tx: Tx, tenantId: string): Promise<OfferSyncSetting> {
  const value = (await readEffectiveSetting(tx, tenantId, OFFER_SYNC_TIMING_KEY)).value;
  return validOfferSyncSetting(value) ? value : OFFER_SYNC_DEFAULT;
}

/**
 * 对 employment 的入站上下文（F-201②）。范围显式给“系统全量”：同步是 Offer 的系统联动，人员 / 任职对象的范围不是
 * 调用方（招聘专员）自己的权限；谁能触发同步由 Offer 对象权限与 Offer 数据范围在入口判定。
 */
function inboundEmploymentContext(ctx: OfferSyncContext, expectedRevision: number): EmploymentContext {
  return {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    timezone: ctx.timezone,
    now: ctx.now,
    commandId: ctx.commandId,
    expectedRevision,
    scope: { orgIds: [], personIds: [], all: true, hasDataPermission: true },
  };
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

const present = (values: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined));

/** 人员信息（34 文末映射：姓名 / 邮箱 / 手机 / 性别 / 证件 / 出生日期）；Offer 没填的项不覆盖已有档案。 */
function profilePatch(offer: OfferRow) {
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

/** 创建人员、绑定用户、生成待入职；返回待入职记录 ID。整个过程在调用方给的保存点里。 */
async function createPendingEntry(tx: Tx, ctx: OfferSyncContext, offer: OfferRow, linked: LinkedPerson | null) {
  const base = inboundEmploymentContext(ctx, 0);
  const kind = offerSyncKind(offer.offerType as OfferType | null);
  if (offer.contractEndDate && offer.contractEndDate < offer.plannedEntryDate!)
    throw new AppError('VALIDATION_FAILED', '合同终止日期不能早于计划入职日期', {
      reason: 'OFFER_CONTRACT_DATE_INVALID',
    });
  // 工号由 Offer ID 派生（同一 Offer 重试不会再造人）；入职准备里的“分配工号”之后再改
  const employeeId =
    linked?.employeeId ?? (await createEmployee(tx, base, { code: `OFR-${offer.id}`, name: offer.name! })).id;
  await appendEmployee(tx, { ...ctx, expectedRevision: 0 }, employeeId, profilePatch(offer), false);
  // DEC-128 / DEC-140：入职类业务同事务绑定租户用户，登录邮箱取 Offer 的个人邮箱
  await provisionEmployeeUser(tx, ctx, {
    employeeId,
    loginEmail: offer.personalEmail!,
    displayName: offer.name!,
    accountRequired: true,
  });
  const employee = await lockEmploymentEmployee(tx, base, employeeId);
  const business = await createEmploymentBusiness(
    tx,
    inboundEmploymentContext(ctx, employee.revision),
    employeeId,
    {
      kind: linked && !linked.active ? 'rehire' : 'hire',
      mode: 'direct',
      effectiveDate: offer.plannedEntryDate!,
      fields: present({
        employType: kind.employType,
        departmentId: offer.departmentId,
        positionId: offer.positionId,
        postId: offer.postId,
        levelId: offer.levelId,
        place: offer.workPlace,
        directManagerId: offer.directManagerId,
        dottedManagerId: offer.dottedManagerId,
      }),
    },
    {
      entry: {
        pendingEntry: true,
        ...(offer.hasProbation === null ? {} : { probation: offer.hasProbation }),
        pendingContract: { startDate: offer.plannedEntryDate!, endDate: offer.contractEndDate },
      },
    },
  );
  return business.id;
}

async function saveSync(tx: Tx, ctx: OfferSyncContext, before: OfferRow, patch: Partial<OfferRow>, action: string) {
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
  const linked = offer.linkedEmployeeId ? await linkedPerson(tx, ctx.tenantId, offer.linkedEmployeeId) : null;
  try {
    const entryId = await tx.transaction((savepoint) => createPendingEntry(savepoint, ctx, offer, linked));
    return await saveSync(
      tx,
      ctx,
      offer,
      {
        pendingEntryBusinessId: entryId,
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

/**
 * 待入职 ↔ Offer 联动端口的 Offer 侧实现（entry-offer-hooks.ts，F-201①），由 offer/routes.ts 在装配时登记。
 * - onEntryRestored：已取消的待入职经改期恢复会换新记录 ID，这里把 Offer 的关联从旧 ID 换到新 ID（同事务，抛错整笔回滚）；
 *   Offer 状态回到已接受是 b3（AC-OF-03 / OF-R9）；
 * - onEntryCancelled：取消不换 ID，关联不变；取消后把 Offer 改为已拒绝（OF-R9 开关、AC-OF-03）是 b3，本单保持空实现。
 */
export const offerEntryHooks: EntryOfferHooks = {
  onEntryCancelled: async () => undefined,
  onEntryRestored: async (tx, ctx, event) => {
    const [before] = await tx
      .select()
      .from(offers)
      .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.pendingEntryBusinessId, event.previousBusinessId)))
      .for('update');
    if (!before) return;
    const [after] = await tx
      .update(offers)
      .set({ pendingEntryBusinessId: event.businessId, revision: before.revision + 1, updatedAt: ctx.now })
      .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, before.id)))
      .returning();
    await audit(tx, ctx, 'entry_relink', before.id, before, after!);
  },
};
