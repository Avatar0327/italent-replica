/**
 * 离职生效时作废晚于最后工作日、已落地的未来调动（DEC-725 ③，保留 DEC-520②“任职显示作废 / 已终止”；取代 DEC-263② 的“只摘下、撤销后挂回”）。
 * 在离职落地、摘下同周期排在其后的调动（detachAndRecord，台账 future_transfer_detached）之后调用，只处理刚摘下的那些：
 * 墓碑（记录永久离开时间轴，覆盖校验与编制占用都按墓碑排除；撤销离职时 reattachFutureTransfers 跳过墓碑，不再挂回）→
 * 状态追加“作废”→ 台账 application_voided → 审计 / outbox（employment.transfer.voided_by_exit）→ 有审批实例的给发起人与申请人发站内消息。
 * 退休暂不作废（F-351），保持只摘下。锁序：员工（已持有）→ 业务头（生效链开头已全部预锁，heads）→ 组织设置 → 通知。
 */
import { randomUUID } from 'node:crypto';
import { exitEffects, type Tx } from '@italent/db';
import { schedulerAwareContext } from '../approval/context.js';
import { notifyMessage } from '../approval/notifications.js';
import { userOfPerson } from '../approval/resolver.js';
import { latestInstanceOf } from '../approval/store.js';
import { lockOrganizationSettings } from '../org/locks.js';
import { auditEmployment } from './context.js';
import {
  bumpEmploymentBusiness,
  insertEmploymentRow,
  lockEmploymentBusiness,
  type LockedEmploymentBusiness,
} from './record-store.js';
import type { EmploymentContext } from './types.js';
import { appendEmploymentState } from './write-service.js';

export async function voidDetachedTransfers(
  tx: Tx,
  ctx: EmploymentContext,
  exit: LockedEmploymentBusiness,
  detached: readonly { readonly recordId: string }[],
  lastWorkDate: string,
  heads: ReadonlyMap<string, number>,
) {
  if (exit.payload.kind === 'retirement' || !detached.length) return [];
  await lockOrganizationSettings(tx, ctx.tenantId);
  const approvalCtx = schedulerAwareContext(ctx);
  const voided: string[] = [];
  for (const id of detached.map((item) => item.recordId).sort()) {
    const business = await lockEmploymentBusiness(tx, { ...ctx, expectedRevision: heads.get(id)! }, id);
    // 员工行已由离职持有；共用同一个员工对象，避免多次递增后员工 revision 回退（同 exit-void-applications.ts）
    business.employee = exit.employee;
    const stateBefore = business.state;
    await insertEmploymentRow(tx, 'employment_record_tombstones', {
      id: randomUUID(),
      tenantId: ctx.tenantId,
      employeeId: business.employeeId,
      recordId: business.id,
      commandId: ctx.commandId,
      createdAt: ctx.now.toISOString(),
    });
    await appendEmploymentState(tx, ctx, business, 'voided', { reason: 'exit', exitBusinessId: exit.id });
    const instance = await latestInstanceOf(tx, ctx.tenantId, 'employment', business.id);
    const detail = {
      kind: business.payload.kind,
      stateBefore,
      effectiveDate: business.payload.effectiveDate,
      instanceId: instance?.id ?? null,
    };
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
      'employment.transfer.voided_by_exit',
      'employment-business',
      business.id,
      { state: stateBefore },
      { state: 'voided', exitBusinessId: exit.id, lastWorkDate, ...detail },
    );
    if (instance) {
      const applicant = await userOfPerson(tx, ctx.tenantId, instance.subjectEmployeeId);
      for (const recipientUserId of new Set([instance.initiatorUserId, applicant].filter((u): u is string => !!u)))
        await notifyMessage(tx, approvalCtx, instance, { recipientUserId, templateCode: 'application_voided_by_exit' });
    }
    await bumpEmploymentBusiness(tx, ctx, business);
    voided.push(business.id);
  }
  return voided;
}
