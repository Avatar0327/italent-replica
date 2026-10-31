/**
 * 离职生效步骤 1：作废全部在途任职申请（R2-T03 设计 §5.1-1、§5.5，DEC-496①；DEC-263③ / DEC-220 是其特例）。
 * 候选 = 该员工除本单外全部未落地的任职业务（最新状态 ∈ 草稿 / 审批中 / 已驳回 / 已批准未落地），不论 kind、不论载荷日期，
 * 与离职预览的“将作废”清单（exit-preview.ts）同一来源。排在离职之前的已批准申请已由步骤 0a 保证先落地，这里剩下的都排在离职之后。
 * 逐条按业务 ID 升序（§5.2 ③ 预锁）：状态置作废 → 审批实例 cancel → 带编调动回退 → 台账 → 审计 / outbox → 站内消息。
 * 任一条失败即整单失败，由调用方的保存点回滚（含已作废的前几条）。
 * 作废实现（voidApplications / voidOne）只有一份：直接实习转正自动作废在途转正申请（DEC-593③③，voidSupersededRegularizations）
 * 复用它，只是原因不同——离职记台账 exit_effects（B4 撤销按它核对），转正不记，审计动作与站内消息模板按原因区分。
 */
import { exitEffects, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { activeInstanceOf, latestInstanceOf } from '../approval/store.js';
import { cancel } from '../approval/actions.js';
import { schedulerAwareContext } from '../approval/context.js';
import { notifyMessage } from '../approval/notifications.js';
import { userOfPerson } from '../approval/resolver.js';
import { assertReleasedEstablishment, reverseCarriedEstablishment } from '../establishment/carried-transfer.js';
import { lockEstablishment } from '../establishment/store.js';
import { lockOrganizationSettings } from '../org/locks.js';
import { auditActor } from '../../system-actor.js';
import { auditEmployment } from './context.js';
import { exceedsVoidLimit, inFlightApplications, VOID_LIMIT, type InFlight } from './exit-gate.js';
import {
  bumpEmploymentBusiness,
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
 */
export async function voidCandidates(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string | null,
  excludeId?: string,
  retirement?: { readonly effectiveDate: string; readonly reEmployed: boolean },
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
  if (rehiring || transfers.some((row) => !row.landed && row.id !== exitId))
    await lockEstablishment(tx, { ...ctx, userId: auditActor(ctx.userId) }, { initializeDefault: false });
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
  const released = kind === 'transfer' ? await reverseCarriedEstablishment(tx, ctx, business.id) : [];
  try {
    await assertReleasedEstablishment(tx, ctx, business.id, business.employeeId, released);
  } catch (error) {
    // 回退带编分配会使原岗位超出严格编制：离职生效失败 ESTABLISHMENT_EXCEEDED，交 HR 处理（§5.1 / B-12）
    if (
      error instanceof AppError &&
      (error.details as { reason?: string } | undefined)?.reason === 'ESTABLISHMENT_EXCEEDED'
    )
      throw new AppError('CONFLICT', error.message, {
        activationFailure: { reason: 'ESTABLISHMENT_EXCEEDED', detail: { voidedBusinessId: business.id } },
      });
    throw error;
  }
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
  // 没有审批实例的草稿无处挂站内消息，只留上面的 outbox 事件（A-7）
  if (instance) {
    const applicant = await userOfPerson(tx, ctx.tenantId, instance.subjectEmployeeId);
    for (const recipientUserId of new Set([instance.initiatorUserId, applicant].filter((id): id is string => !!id)))
      await notifyMessage(tx, approvalCtx, instance, { recipientUserId, templateCode: described.template });
  }
  await bumpEmploymentBusiness(tx, ctx, business);
  return { id: business.id, ...detail };
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
  return voided;
}

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
