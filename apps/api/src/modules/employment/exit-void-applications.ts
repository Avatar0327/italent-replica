/**
 * 离职生效步骤 1：作废全部在途任职申请（R2-T03 设计 §5.1-1、§5.5，DEC-496①；DEC-263③ / DEC-220 是其特例）。
 * 候选 = 该员工除本单外全部未落地的任职业务（最新状态 ∈ 草稿 / 审批中 / 已驳回 / 已批准未落地），不论 kind、不论载荷日期，
 * 与离职预览的“将作废”清单（exit-preview.ts）同一来源。排在离职之前的已批准申请已由步骤 0a 保证先落地，这里剩下的都排在离职之后。
 * 逐条按业务 ID 升序（§5.2 ③ 预锁）：状态置作废 → 审批实例 cancel → 台账 → 审计 / outbox → 站内消息；
 * 晚于最后工作日、已落地的未来调动（DEC-725 ③）在离职落地摘下后也走这里（voidLandedTransfers）：先立墓碑，再同一套作废步骤。
 * 一次离职实际作废的全部带编调动（在途组 + 已落地组）是同一个回退单元（F-400 r4）：两组都作废完后，由离职生效链
 * 调一次 releaseVoidedEstablishment，按编制对象汇总净变化、只校验最终状态；回退不合法时整单回滚。
 * 任一条失败即整单失败，由调用方的保存点回滚（含已作废的前几条）。
 * 作废实现（voidApplications / voidOne）只有一份：直接实习转正自动作废在途转正申请（DEC-593③③，voidSupersededRegularizations）
 * 复用它，只是原因不同——离职记台账 exit_effects（B4 撤销按它核对），转正不记，审计动作与站内消息模板按原因区分。
 */
import { randomUUID } from 'node:crypto';
import { exitEffects, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { activeInstanceOf, latestInstanceOf, type InstanceRow } from '../approval/store.js';
import { cancel } from '../approval/actions.js';
import { schedulerAwareContext } from '../approval/context.js';
import { notifyMessage } from '../approval/notifications.js';
import { userOfPerson } from '../approval/resolver.js';
import { assertReleasedEstablishment, reverseCarriedEstablishmentGroup } from '../establishment/carried-transfer.js';
import { lockEstablishment } from '../establishment/store.js';
import { lockOrganizationSettings } from '../org/locks.js';
import { auditActor } from '../../system-actor.js';
import { auditEmployment, employmentCreator } from './context.js';
import {
  exceedsVoidLimit,
  inFlightApplications,
  untickedEmploymentKeep,
  VOID_LIMIT,
  type InFlight,
  type InFlightFilter,
} from './exit-gate.js';
import {
  bumpEmploymentBusiness,
  insertEmploymentRow,
  lockEmploymentBusiness,
  rowsOf,
  type EmploymentEmployeeRow,
  type LockedEmploymentBusiness,
} from './record-store.js';
import { loadRetirementRequest } from './retirement-application.js';
import { rehireSurvivesRetirement } from './retire-rehire-eligibility.js';
import { timelinePosition } from './timeline.js';
import { dayAfter } from './fields.js';
import { BUSINESS_KINDS, type EmploymentContext } from './types.js';
import { appendEmploymentState } from './write-service.js';

/** 除离职本身外所有 kind（含退休）的在途申请都在作废之列（§5.1-1、A-10 “不论 kind”）；预览与执行共用。 */
export const VOIDABLE_KINDS = BUSINESS_KINDS.filter((kind) => kind !== 'leave');
export const OPEN_STATES = ['draft', 'in_review', 'approved', 'rejected'];
export { exceedsVoidLimit, VOID_LIMIT };

/**
 * 待作废候选与超限判定的单一入口：预览提示（exit-preview.ts）与生效时整单拒绝共用，不各写一套（DEC-431①）。
 * 条件全部在 SQL 里过滤后再取 VOID_LIMIT + 1，所以返回超过上限即真实超限，不会被前序申请挤占名额（F-237）。
 * lastWorkDate：预览传最后工作日，已批准且计划生效日 ≤ 它的会先于离职落地，不算；生效时传 null——这些已由步骤 0a 落地，
 * 剩下的未落地申请全部作废。
 * keepOnOrBefore：DEC-725 “离职生效时终止在途流程”未勾选的任职类型，计划生效日 ≤ L 的保留（untickedEmploymentKeep）。
 */
export async function voidCandidates(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string | null,
  excludeId?: string,
  retirement?: { readonly effectiveDate: string; readonly reEmployed: boolean },
  keepOnOrBefore?: InFlightFilter['keepOnOrBefore'],
) {
  const excluding = retirement
    ? rehireSurvivesRetirement(
        ctx.tenantId,
        employeeId,
        await timelinePosition(tx, ctx, employeeId, retirement.effectiveDate, excludeId),
        retirement.reEmployed ? dayAfter(retirement.effectiveDate) : undefined,
        excludeId,
      )
    : undefined;
  return inFlightApplications(tx, ctx, employeeId, VOIDABLE_KINDS, OPEN_STATES, 'application', {
    unlanded: true,
    excluding,
    ...(excludeId ? { excludeId } : {}),
    ...(lastWorkDate ? { approvedAfter: lastWorkDate } : {}),
    keepOnOrBefore,
  });
}

export interface VoidedApplication {
  readonly id: string;
  readonly kind: string;
  readonly stateBefore: string;
  readonly effectiveDate: string;
  readonly instanceId: string | null;
}

const idArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** §5.2 ③：该员工其他任职业务头按 id 升序 FOR UPDATE；返回各自 revision（锁业务头校验用）。exitId 为空 = 全部业务头。 */
export async function lockOtherBusinessHeads(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  exitId: string | null,
) {
  const heads = rowsOf<{ id: string; revision: number }>(
    await tx.execute(sql`SELECT id, revision FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid
        AND (${exitId}::uuid IS NULL OR id<>${exitId}::uuid)
      ORDER BY id FOR UPDATE`),
  );
  return new Map(heads.map((head) => [head.id, Number(head.revision)]));
}

/**
 * §5.2 ④ ⑤ 组织资源预锁（B3-3）：org/locks.ts 全局序是 员工 → 业务头 → 组织设置 → 编制 → 审批实例。生效链的各步（顺延后的部门复核、
 * 带编调动回退、组织角色转交）会在中途首次取组织 / 编制锁，而步骤 1 的 lockInstances 先于它们执行，会与“组织锁 → 审批实例”的其他路径成环。
 * 所以调度、审批落地、直接保存、activate / retry 进入生效链后统一先在这里取齐：组织设置锁一律取；有未落地的调动申请
 * （步骤 1 要回退其带编分配）时再取编制锁。之后各步只是重入已持有的锁。
 * 直接实习转正（F-257）后面紧跟的编制检查（employment-check.ts）一定会取编制锁，所以传 establishment: true 无条件先取，
 * 与检查同一把锁、同一顺序（组织 → 编制），避免实例锁先于编制锁。
 */
export async function lockExitOrganizationResources(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  exitId: string | null,
  options: { readonly establishment?: boolean } = {},
) {
  await lockOrganizationSettings(tx, ctx.tenantId);
  if (options.establishment) {
    await lockEstablishment(tx, { ...ctx, userId: auditActor(ctx.userId) }, { initializeDefault: false });
    return;
  }
  const transfers = await inFlightApplications(tx, ctx, employeeId, ['transfer'], OPEN_STATES);
  // 同时返聘的退休生效会在保存点里生成返聘任职并过编制校验（R2-T04 §8.3-1）：编制锁也在这里先于审批实例取齐，保存点内只是重入
  const rehiring = exitId !== null && (await loadRetirementRequest(tx, ctx.tenantId, exitId))?.reEmployed === true;
  if (
    rehiring ||
    transfers.some((row) => !row.landed && row.id !== exitId) ||
    (await hasCarriedAllocation(tx, ctx.tenantId, employeeId, exitId))
  )
    await lockEstablishment(tx, { ...ctx, userId: auditActor(ctx.userId) }, { initializeDefault: false });
}

/**
 * 员工其他业务是否还有未回退的带编分配：已落地的未来带编调动被离职作废时要回退（voidLandedTransfers），编制锁须先于审批实例取齐。
 * 只看“有未回退分配”，不判断是否晚于最后工作日（此时还不知道哪些会被摘下）：取锁范围是超集，多取一次编制锁只多一点串行，不会漏锁成环。
 * 有意保守（F-400 r3 P3-4，不收窄为“分配所属业务生效日 > 最后工作日”）：本函数被激活、撤销、改期与审批回调多个入口共用，
 * 改期 / 迟到顺延会在取锁之后才改变最后工作日，摘下集合要到 detach 之后才确定；收窄后须逐入口证明仍是超集，漏一处即锁序倒置。
 * 整组回退（releaseVoidedEstablishment）在站内消息之后执行，更依赖这里预先取齐编制锁。
 */
async function hasCarriedAllocation(tx: Tx, tenantId: string, employeeId: string, exitId: string | null) {
  const [row] = rowsOf<{ found: boolean }>(
    await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM transfer_establishment_allocations a
        JOIN employment_business_objects b ON b.tenant_id=a.tenant_id AND b.id=a.business_id
        WHERE a.tenant_id=${tenantId} AND b.employee_id=${employeeId}::uuid AND NOT a.reversed
          AND (${exitId}::uuid IS NULL OR b.id<>${exitId}::uuid)) AS found`),
  );
  return row?.found === true;
}

/** §5.2 ⑥：其他审批实例按 id 升序 FOR UPDATE，之后逐个 cancel。 */
async function lockInstances(tx: Tx, ctx: EmploymentContext, businessIds: readonly string[]) {
  if (!businessIds.length) return;
  await tx.execute(sql`SELECT id FROM approval_instances WHERE tenant_id=${ctx.tenantId}
    AND business_type='employment' AND business_id=ANY(${idArray(businessIds)}) AND status IN ('running','returned')
    ORDER BY id FOR UPDATE`);
}

/** 作废原因：离职生效步骤 1，或直接实习转正（DEC-593③③）。 */
type VoidCause =
  | { readonly kind: 'exit'; readonly exit: LockedEmploymentBusiness; readonly lastWorkDate: string }
  | { readonly kind: 'direct_regularization'; readonly employee: EmploymentEmployeeRow };

/** 各原因的状态事件说明、审计动作、审计附加字段与站内消息模板（其余步骤完全相同）。 */
function describeCause(cause: VoidCause, kind: string) {
  if (cause.kind === 'direct_regularization')
    return {
      employee: cause.employee,
      meta: { reason: 'direct_regularization' },
      action: 'employment.business.voided_by_regularization',
      extra: { reason: 'direct_regularization' },
      template: 'application_voided_by_regularization',
    };
  const { exit, lastWorkDate } = cause;
  return {
    employee: exit.employee,
    meta: { reason: 'exit', exitBusinessId: exit.id },
    action: kind === 'transfer' ? 'employment.transfer.voided_by_exit' : 'employment.business.voided_by_exit',
    extra: { exitBusinessId: exit.id, lastWorkDate },
    template: 'application_voided_by_exit',
  };
}

/** 台账与审计里的 effectiveDate 取该申请最新载荷的生效日（只作说明，不参与判断）。 */
async function voidOne(
  tx: Tx,
  ctx: EmploymentContext,
  cause: VoidCause,
  business: LockedEmploymentBusiness,
): Promise<VoidedApplication> {
  const { kind, effectiveDate } = business.payload;
  const stateBefore = business.state;
  const described = describeCause(cause, kind);
  const approvalCtx = schedulerAwareContext(ctx);
  // 活动实例（running / returned）才要取消；通知挂在最近相关的实例上，审批已通过的申请没有活动实例但发起人仍应收到消息
  const active = await activeInstanceOf(tx, ctx.tenantId, 'employment', business.id);
  const instance = active ?? (await latestInstanceOf(tx, ctx.tenantId, 'employment', business.id));
  await appendEmploymentState(tx, ctx, business, 'voided', described.meta);
  if (active) await cancel(tx, approvalCtx, active.id);
  const detail = { kind, stateBefore, effectiveDate, instanceId: instance?.id ?? null };
  if (cause.kind === 'exit')
    await tx.insert(exitEffects).values({
      tenantId: ctx.tenantId,
      businessId: cause.exit.id,
      employeeId: cause.exit.employeeId,
      phase: 'effective',
      kind: 'application_voided',
      targetType: 'employment-business',
      targetId: business.id,
      detail,
      commandId: ctx.commandId,
      createdAt: ctx.now,
    });
  await auditEmployment(
    tx,
    ctx,
    described.action,
    'employment-business',
    business.id,
    { state: stateBefore },
    { state: 'voided', ...described.extra, ...detail },
  );
  await notifyVoided(tx, ctx, business, instance, described.template);
  await bumpEmploymentBusiness(tx, ctx, business);
  return { id: business.id, ...detail };
}

/**
 * 作废的站内消息发给发起人与申请人（同一人只发一条）。有审批实例时挂实例、发起人取实例发起人；没有审批实例（草稿、直接办理的
 * 未来调动）时挂业务单、发起人取业务单创建人（F-400，取代 A-7 “无实例只写 outbox”）。不伪造审批实例。
 */
async function notifyVoided(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  instance: InstanceRow | null | undefined,
  templateCode: string,
) {
  const initiator = instance ? instance.initiatorUserId : await businessCreator(tx, ctx.tenantId, business.id);
  const applicant = await userOfPerson(tx, ctx.tenantId, instance?.subjectEmployeeId ?? business.employeeId);
  const target = instance ?? { businessType: 'employment', businessId: business.id };
  for (const recipientUserId of new Set([initiator, applicant].filter((id): id is string => !!id)))
    await notifyMessage(tx, schedulerAwareContext(ctx), target, { recipientUserId, templateCode });
}

/**
 * 一个回退单元作废完后，带编调动的分配整组回退（F-400 r3 / r4）。离职：同一次离职的在途申请与摘下的已落地调动合并成一个单元，
 * 由 exit-activation.ts 在两组都作废后调用一次；直接转正：作废的转正申请（候选只有 intern_regularization，没有带编分配）。
 * 按编制对象汇总净变化、每个对象写一次最终值（reverseCarriedEstablishmentGroup → applyCapacityNet），不因业务 ID 顺序、
 * 分组或上下限附近的中间值误判失败；回退后再逐单复核原调入方的严格控编（此时整组都已作废，复核看到的就是最终占用）。
 * 失败随调用方保存点 / 事务整体回滚。
 */
export async function releaseVoidedEstablishment(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  voided: readonly VoidedApplication[],
) {
  const transfers = voided.filter((row) => row.kind === 'transfer').map((row) => row.id);
  if (!transfers.length) return;
  const released = await reverseCarriedEstablishmentGroup(tx, ctx, transfers);
  for (const [businessId, rows] of released) {
    try {
      await assertReleasedEstablishment(tx, ctx, businessId, employeeId, rows);
    } catch (error) {
      // 回退带编分配会使原岗位超出严格编制：离职生效失败 ESTABLISHMENT_EXCEEDED，交 HR 处理（§5.1 / B-12）
      if (
        error instanceof AppError &&
        (error.details as { reason?: string } | undefined)?.reason === 'ESTABLISHMENT_EXCEEDED'
      )
        throw new AppError('CONFLICT', error.message, {
          activationFailure: { reason: 'ESTABLISHMENT_EXCEEDED', detail: { voidedBusinessId: businessId } },
        });
      throw error;
    }
  }
}

async function businessCreator(tx: Tx, tenantId: string, businessId: string) {
  const [row] = rowsOf<{ creator: string | null }>(
    await tx.execute(sql`SELECT ${employmentCreator(tenantId, sql`${businessId}::uuid`, true)} AS creator`),
  );
  return row?.creator ?? null;
}

/** 超限整单拒绝：离职生效记 activationFailure（交 HR 重试），直接转正是明确的 409。 */
function tooManyToVoid(cause: VoidCause) {
  if (cause.kind === 'exit')
    return new AppError('CONFLICT', '在途任职申请过多，请先处理后再办理离职', {
      activationFailure: { reason: 'EXIT_APPLICATIONS_TOO_MANY', detail: { limit: VOID_LIMIT } },
    });
  return new AppError('CONFLICT', '在途任职申请过多，请先处理后再办理实习转正', {
    reason: 'EXIT_APPLICATIONS_TOO_MANY',
    limit: VOID_LIMIT,
  });
}

/**
 * 作废在途申请的单一入口（DEC-431①）：离职生效步骤 1 与直接实习转正共用，下面两件事只在这里做一份——
 * ① 候选被截断（至多取 VOID_LIMIT + 1 条）时在任何写入之前整单拒绝，不会作废一部分就返回成功；
 * ② 锁序：调用方已持员工锁与全部业务头（heads），先取齐组织 / 编制资源，再锁审批实例并发站内消息
 *   （全局序 员工 → 业务头 → 组织 → 编制 → 实例；通知插入会取成员行的外键锁，晚于组织锁才不会与先持组织锁、再锁成员行的路径成环）。
 * 逐条按业务 ID 升序：先锁审批实例，再逐条锁业务头、作废。heads 是调用方已预锁的各业务头 revision。
 * 带编回退：直接转正在这里整组回退；离职不在这里回退，交给离职生效链与已落地组合并后一次回退（F-400 r4，见 releaseVoidedEstablishment）。
 */
async function voidApplications(
  tx: Tx,
  ctx: EmploymentContext,
  cause: VoidCause,
  candidates: readonly InFlight[],
  heads: ReadonlyMap<string, number>,
): Promise<VoidedApplication[]> {
  if (exceedsVoidLimit(candidates)) throw tooManyToVoid(cause);
  const open = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  if (!open.length) return [];
  const { employee } = describeCause(cause, '');
  await lockExitOrganizationResources(tx, ctx, employee.id, cause.kind === 'exit' ? cause.exit.id : null, {
    establishment: cause.kind === 'direct_regularization',
  });
  await lockInstances(
    tx,
    ctx,
    open.map((row) => row.id),
  );
  const voided: VoidedApplication[] = [];
  for (const row of open) {
    const business = await lockEmploymentBusiness(tx, { ...ctx, expectedRevision: heads.get(row.id)! }, row.id);
    // 员工行已由调用方持有；共用同一个员工对象，避免多次递增后员工 revision 回退
    business.employee = employee;
    voided.push(await voidOne(tx, ctx, cause, business));
  }
  if (cause.kind === 'direct_regularization') await releaseVoidedEstablishment(tx, ctx, employee.id, voided);
  return voided;
}

/**
 * 离职生效步骤 1。只作废、不回退带编分配：返回的作废清单须由调用方与已落地组（voidLandedTransfers）合并后
 * 调一次 releaseVoidedEstablishment（F-400 r4）；分两段回退时中间状态可能超编或越界，而最终状态合法。
 */
export async function voidInFlightApplications(
  tx: Tx,
  ctx: EmploymentContext,
  exit: LockedEmploymentBusiness,
  lastWorkDate: string,
  heads: ReadonlyMap<string, number>,
): Promise<VoidedApplication[]> {
  const retirement =
    exit.payload.kind === 'retirement' ? await loadRetirementRequest(tx, ctx.tenantId, exit.id) : undefined;
  const candidates = await voidCandidates(
    tx,
    ctx,
    exit.employeeId,
    null,
    exit.id,
    retirement ? { effectiveDate: dayAfter(lastWorkDate), reEmployed: retirement.reEmployed } : undefined,
    await untickedEmploymentKeep(tx, ctx, lastWorkDate, exit.payload.kind),
  );
  return voidApplications(tx, ctx, { kind: 'exit', exit, lastWorkDate }, candidates, heads);
}

/**
 * DEC-593③③：直接实习转正（免审批）办理时，自动作废该人在途的实习转正申请（审批中 / 审批通过未生效）——
 * 同一人不会同时有两条转正，也不留一条后来必然落地失败的申请。调用方须已持员工行锁（createEmploymentBusiness），
 * 在取任何组织 / 编制锁之前调用（§5.2 锁序：员工 → 业务头 → … → 审批实例）；失败随调用方事务整体回滚。
 * 申请方式（mode = application）再提一条仍 409，见 intern-eligibility.ts。
 */
export async function voidSupersededRegularizations(
  tx: Tx,
  ctx: EmploymentContext,
  employee: EmploymentEmployeeRow,
): Promise<VoidedApplication[]> {
  const candidates = await inFlightApplications(
    tx,
    ctx,
    employee.id,
    ['intern_regularization'],
    ['in_review', 'approved'],
    'application',
    { unlanded: true },
  );
  if (!candidates.length) return [];
  const heads = await lockOtherBusinessHeads(tx, ctx, employee.id, null);
  return voidApplications(tx, ctx, { kind: 'direct_regularization', employee }, candidates, heads);
}

/**
 * DEC-725 ③：离职落地摘下的、晚于最后工作日的已落地调动（detachAndRecord 台账 future_transfer_detached）一律作废
 * （保留 DEC-520②“任职显示作废 / 已终止”）。逐条：墓碑（记录永久离开时间轴，覆盖校验与编制占用都按墓碑排除；
 * 撤销离职时 reattachFutureTransfers 跳过墓碑，不再挂回）→ 与在途申请同一个 voidOne（作废、台账、审计、站内消息）；
 * 只作废、不回退：返回的作废清单由调用方与步骤 1 的在途组合并，调一次 releaseVoidedEstablishment（F-400 r4）。
 * 这些调动可能首尾相接、也可能与在途调动首尾相接，不能逐笔或分组回退。退休暂不作废（F-351），保持只摘下。锁序：员工（已持有）→ 业务头（heads，生效链开头已预锁）→ 组织设置 / 编制（激活入口
 * lockExitOrganizationResources 已按“有未回退带编分配”取齐，这里只是重入）→ 通知。
 */
export async function voidLandedTransfers(
  tx: Tx,
  ctx: EmploymentContext,
  exit: LockedEmploymentBusiness,
  detached: readonly { readonly recordId: string }[],
  lastWorkDate: string,
  heads: ReadonlyMap<string, number>,
): Promise<VoidedApplication[]> {
  if (exit.payload.kind === 'retirement' || !detached.length) return [];
  await lockExitOrganizationResources(tx, ctx, exit.employeeId, exit.id);
  const voided: VoidedApplication[] = [];
  for (const id of detached.map((item) => item.recordId).sort()) {
    const business = await lockEmploymentBusiness(tx, { ...ctx, expectedRevision: heads.get(id)! }, id);
    business.employee = exit.employee;
    await insertEmploymentRow(tx, 'employment_record_tombstones', {
      id: randomUUID(),
      tenantId: ctx.tenantId,
      employeeId: business.employeeId,
      recordId: business.id,
      commandId: ctx.commandId,
      createdAt: ctx.now.toISOString(),
    });
    voided.push(await voidOne(tx, ctx, { kind: 'exit', exit, lastWorkDate }, business));
  }
  return voided;
}
