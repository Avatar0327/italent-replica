/**
 * Offer 同步的取锁单一入口（BE-14b2 第 4 轮 P2-2，DEC-431①）。
 * 全局锁序（org/locks.ts、employment/transfer-locks.ts，F-008 / DEC-196）：参与员工闭包（UUID 升序）→ 业务头 → 组织设置 →
 * 编制设置 → 审批实例。Offer 同步在它前面再加一级：**Offer 行 → 员工闭包 → 业务头 → 组织 / 编制**。
 *
 * 同步要复用已有人员（关联的实习生）时，员工与业务头必须在任何会取组织 / 编制锁的判定（弱控确认、强控检查、任职落地）之前
 * 取齐，否则“发送先取编制锁再等员工锁”与“立即同步先取员工锁再取编制锁”会成环（40P01，被包装成 409 OFFER_CONCURRENT_CONFLICT）。
 * 各路径的取锁顺序（都经本入口，重入安全）：
 * - 发送 / 重发（send.ts）：lockOffer → lockOfferSyncScope → 弱控确认（组织 → 编制）→ 写发送记录 → 同步；
 * - 接受（transferOffer）：lockOffer → lockOfferSyncScope → 弱控确认 → 同步；
 * - 立即同步 / 夜间任务（syncOfferNow / syncOfferWhenDue → syncOffer）：lockOffer → lockOfferSyncScope → 强控检查 → 任职落地；
 * - 改期恢复 / 取消（entry-offer-hooks beforeEntryAction）：Offer 行 → 员工 → 业务 → 组织（employment 内核本身的序）。
 * 新建的人员没有别人能争，不需要预锁。
 */
import { sql, type Tx } from '@italent/db';
import { lockTransferParticipants } from '../employment/transfer-locks.js';
import type { EmploymentContext } from '../employment/types.js';
import type { OfferContext } from './context.js';
import type { OfferRow } from './service.js';

/** 同步需要的上下文子集：立即同步取自请求，夜间任务由系统构造。 */
export type OfferSyncContext = Pick<OfferContext, 'tenantId' | 'userId' | 'timezone' | 'now' | 'commandId'>;

/**
 * 对 employment 的入站上下文（F-201②）。范围显式给“系统全量”：同步是 Offer 的系统联动，人员 / 任职对象的范围不是
 * 调用方（招聘专员）自己的权限；谁能触发同步由 Offer 对象权限与 Offer 数据范围在入口判定。
 */
export function inboundEmploymentContext(ctx: OfferSyncContext, expectedRevision: number): EmploymentContext {
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

/** 调用方已持有 Offer 行锁；关联了已有人员时，先取齐该人员的员工闭包与全部业务头。 */
export async function lockOfferSyncScope(
  tx: Tx,
  ctx: OfferSyncContext,
  offer: Pick<OfferRow, 'linkedEmployeeId'>,
): Promise<void> {
  if (!offer.linkedEmployeeId) return;
  await lockTransferParticipants(tx, inboundEmploymentContext(ctx, 0), offer.linkedEmployeeId);
  await tx.execute(sql`SELECT id FROM employment_business_objects
    WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${offer.linkedEmployeeId}::uuid ORDER BY id FOR UPDATE`);
}
