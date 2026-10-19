/**
 * 离职生效步骤 1：作废全部在途任职申请（R2-T03 设计 §5.1-1、§5.5，DEC-496①；DEC-263③ / DEC-220 是其特例）。
 * 候选 = 该员工除本单外全部未落地的任职业务（最新状态 ∈ 草稿 / 审批中 / 已驳回 / 已批准未落地），不论 kind、不论载荷日期，
 * 与离职预览的“将作废”清单（exit-preview.ts）同一来源。排在离职之前的已批准申请已由步骤 0a 保证先落地，这里剩下的都排在离职之后。
 * 逐条按业务 ID 升序（§5.2 ③ 预锁）：状态置作废 → 审批实例 cancel → 带编调动回退 → 台账 → 审计 / outbox → 站内消息。
 * 任一条失败即整单失败，由调用方的保存点回滚（含已作废的前几条）。
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
import { exceedsVoidLimit, inFlightApplications, VOID_LIMIT } from './exit-gate.js';
import {
  bumpEmploymentBusiness,
  lockEmploymentBusiness,
  rowsOf,
  type LockedEmploymentBusiness,
} from './record-store.js';
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
export const voidCandidates = (
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string | null,
  excludeId?: string,
) =>
  inFlightApplications(tx, ctx, employeeId, VOIDABLE_KINDS, OPEN_STATES, 'application', {
    unlanded: true,
    ...(excludeId ? { excludeId } : {}),
    ...(lastWorkDate ? { approvedAfter: lastWorkDate } : {}),
  });

export interface VoidedApplication {
  readonly id: string;
  readonly kind: string;
  readonly stateBefore: string;
  readonly effectiveDate: string;
  readonly instanceId: string | null;
}

const idArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** §5.2 ③：该员工其他任职业务头按 id 升序 FOR UPDATE；返回各自 revision（锁业务头校验用）。 */
export async function lockOtherBusinessHeads(tx: Tx, ctx: EmploymentContext, employeeId: string, exitId: string) {
  const heads = rowsOf<{ id: string; revision: number }>(
    await tx.execute(sql`SELECT id, revision FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND id<>${exitId}::uuid
      ORDER BY id FOR UPDATE`),
  );
  return new Map(heads.map((head) => [head.id, Number(head.revision)]));
}

/**
 * §5.2 ④ ⑤ 组织资源预锁（B3-3）：org/locks.ts 全局序是 员工 → 业务头 → 组织设置 → 编制 → 审批实例。生效链的各步（顺延后的部门复核、
 * 带编调动回退、组织角色转交）会在中途首次取组织 / 编制锁，而步骤 1 的 lockInstances 先于它们执行，会与“组织锁 → 审批实例”的其他路径成环。
 * 所以调度、审批落地、直接保存、activate / retry 进入生效链后统一先在这里取齐：组织设置锁一律取；有未落地的调动申请
 * （步骤 1 要回退其带编分配）时再取编制锁。之后各步只是重入已持有的锁。
 */
export async function lockExitOrganizationResources(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  exitId: string,
) {
  await lockOrganizationSettings(tx, ctx.tenantId);
  const transfers = await inFlightApplications(tx, ctx, employeeId, ['transfer'], OPEN_STATES);
  if (transfers.some((row) => !row.landed && row.id !== exitId))
    await lockEstablishment(tx, { ...ctx, userId: auditActor(ctx.userId) }, { initializeDefault: false });
}

/** §5.2 ⑥：其他审批实例按 id 升序 FOR UPDATE，之后逐个 cancel。 */
async function lockInstances(tx: Tx, ctx: EmploymentContext, businessIds: readonly string[]) {
  if (!businessIds.length) return;
  await tx.execute(sql`SELECT id FROM approval_instances WHERE tenant_id=${ctx.tenantId}
    AND business_type='employment' AND business_id=ANY(${idArray(businessIds)}) AND status IN ('running','returned')
    ORDER BY id FOR UPDATE`);
}

/** 台账与审计里的 effectiveDate 取该申请最新载荷的生效日（只作说明，不参与判断）。 */
async function voidOne(
  tx: Tx,
  ctx: EmploymentContext,
  exit: LockedEmploymentBusiness,
  lastWorkDate: string,
  business: LockedEmploymentBusiness,
): Promise<VoidedApplication> {
  const { kind, effectiveDate } = business.payload;
  const stateBefore = business.state;
  const approvalCtx = schedulerAwareContext(ctx);
  // 活动实例（running / returned）才要取消；通知挂在最近相关的实例上，审批已通过的申请没有活动实例但发起人仍应收到消息
  const active = await activeInstanceOf(tx, ctx.tenantId, 'employment', business.id);
  const instance = active ?? (await latestInstanceOf(tx, ctx.tenantId, 'employment', business.id));
  await appendEmploymentState(tx, ctx, business, 'voided', { reason: 'exit', exitBusinessId: exit.id });
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
  await tx.insert(exitEffects).values({
    tenantId: ctx.tenantId,
    businessId: exit.id,
    employeeId: exit.employeeId,
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
    kind === 'transfer' ? 'employment.transfer.voided_by_exit' : 'employment.business.voided_by_exit',
    'employment-business',
    business.id,
    { state: stateBefore },
    { state: 'voided', exitBusinessId: exit.id, lastWorkDate, ...detail },
  );
  // 没有审批实例的草稿无处挂站内消息，只留上面的 outbox 事件（A-7）
  if (instance) {
    const applicant = await userOfPerson(tx, ctx.tenantId, instance.subjectEmployeeId);
    for (const recipientUserId of new Set([instance.initiatorUserId, applicant].filter((id): id is string => !!id)))
      await notifyMessage(tx, approvalCtx, instance, { recipientUserId, templateCode: 'application_voided_by_exit' });
  }
  await bumpEmploymentBusiness(tx, ctx, business);
  return { id: business.id, ...detail };
}

export async function voidInFlightApplications(
  tx: Tx,
  ctx: EmploymentContext,
  exit: LockedEmploymentBusiness,
  lastWorkDate: string,
  heads: ReadonlyMap<string, number>,
): Promise<VoidedApplication[]> {
  const open = (await voidCandidates(tx, ctx, exit.employeeId, null, exit.id)).sort((a, b) => a.id.localeCompare(b.id));
  // 候选查询被截断时不能只作废一部分：在任何写入之前整单拒绝，HR 处理掉多余的申请后重试
  if (exceedsVoidLimit(open))
    throw new AppError('CONFLICT', '在途任职申请过多，请先处理后再办理离职', {
      activationFailure: { reason: 'EXIT_APPLICATIONS_TOO_MANY', detail: { limit: VOID_LIMIT } },
    });
  await lockInstances(
    tx,
    ctx,
    open.map((row) => row.id),
  );
  const voided: VoidedApplication[] = [];
  for (const row of open) {
    const business = await lockEmploymentBusiness(tx, { ...ctx, expectedRevision: heads.get(row.id)! }, row.id);
    // 员工行已由本单持有；共用同一个员工对象，避免多次递增后员工 revision 回退
    business.employee = exit.employee;
    voided.push(await voidOne(tx, ctx, exit, lastWorkDate, business));
  }
  return voided;
}
