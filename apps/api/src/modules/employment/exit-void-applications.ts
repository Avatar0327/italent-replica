/**
 * 离职生效步骤 1：作废全部在途任职申请（R2-T03 设计 §5.1-1、§5.5，DEC-496①；DEC-263③ / DEC-220 是其特例）。
 * 候选 = 该员工除本单外全部未落地的任职业务（最新状态 ∈ 草稿 / 审批中 / 已驳回 / 已批准未落地），不论 kind、不论载荷日期，
 * 与离职预览的“将作废”清单（exit-preview.ts）同一来源。排在离职之前的已批准申请已由步骤 0a 保证先落地，这里剩下的都排在离职之后。
 * 逐条按业务 ID 升序（§5.2 ③ 预锁）：状态置作废 → 审批实例 cancel → 带编调动回退 → 台账 → 审计 / outbox → 站内消息。
 * 任一条失败即整单失败，由调用方的保存点回滚（含已作废的前几条）。
 */
import { exitEffects, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { activeInstanceOf } from '../approval/store.js';
import { cancel } from '../approval/actions.js';
import { notifyMessage } from '../approval/notifications.js';
import { userOfPerson } from '../approval/resolver.js';
import { assertReleasedEstablishment, reverseCarriedEstablishment } from '../establishment/carried-transfer.js';
import { auditEmployment } from './context.js';
import { inFlightApplications } from './exit-gate.js';
import {
  bumpEmploymentBusiness,
  lockEmploymentBusiness,
  rowsOf,
  type LockedEmploymentBusiness,
} from './record-store.js';
import { BUSINESS_KINDS, type EmploymentContext } from './types.js';
import { appendEmploymentState } from './write-service.js';

/** 离职 / 退休本身不在被作废之列（退休归 R2-T04）。 */
export const VOIDABLE_KINDS = BUSINESS_KINDS.filter((kind) => kind !== 'leave' && kind !== 'retirement');
export const OPEN_STATES = ['draft', 'in_review', 'approved', 'rejected'];

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
  const instance = await activeInstanceOf(tx, ctx.tenantId, 'employment', business.id);
  await appendEmploymentState(tx, ctx, business, 'voided', { reason: 'exit', exitBusinessId: exit.id });
  if (instance) await cancel(tx, ctx, instance.id);
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
      await notifyMessage(tx, ctx, instance, { recipientUserId, templateCode: 'application_voided_by_exit' });
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
  const open = (await inFlightApplications(tx, ctx, exit.employeeId, VOIDABLE_KINDS, OPEN_STATES))
    .filter((row) => !row.landed && row.id !== exit.id)
    .sort((a, b) => a.id.localeCompare(b.id));
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
