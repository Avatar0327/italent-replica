/**
 * Offer ↔ 待入职联动（R2 BE-14b3；docs/02_业务建模/34 §2.1、OF-R4 / R9 / R14，F-201 ①②③，DEC-600）。
 * 两个方向，都在调用方同一事务里，锁序全程“Offer 行 → 员工 → 业务头 → 组织”（与 beforeEntryAction、sync-lock.ts 一致）：
 * - 出站（Offer → employment，经 pendingEntry 端口）：转已拒绝 / 已发退回待发取消入职、失效删除待入职、编辑并同步推送。
 *   入站调用都带受控上下文（inboundEmploymentContext）和取锁后读到的当前业务 revision，范围显式给“系统全量”，不靠省略范围；
 * - 入站（待入职 → Offer，offerEntryHooks）：取消入职按 OF-R9 开关改已拒绝、办理入职改已入职、改期恢复换关联并回已接受。
 * 联动目标只认待入职（sync_target = pending_entry）；实习转正产物没有可取消 / 删除的待入职，Offer 侧只改自己的状态。
 * 待入职被手工删除（DELETE /pending-entries，不改 Offer，R2e8 / DEC-546）后 Offer 上的关联悬空：这里读不到“活”的记录就跳过联动。
 */
import { and, eq, offers, sql, type Tx } from '@italent/db';
import {
  OFFER_ENTRY_CANCEL_REFUSAL_REASON,
  OFFER_LINKAGE_DEFAULT,
  OFFER_LINKAGE_KEY,
  offerRejectsOnEntryCancel,
  tenantLocalDate,
  validOfferLinkageSetting,
  type OfferLinkageSetting,
} from '@italent/domain';
import { ruleRejection } from '../employment/activation-checks.js';
import {
  cancelPendingEntryForOfferRefusal,
  deletePendingEntry,
  pushOfferToPendingEntry,
} from '../employment/entry-actions.js';
import type { EntryOfferHooks } from '../employment/entry-offer-hooks.js';
import { lockEmploymentEmployee, rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { appendEmployee } from '../personnel/employee-write.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import type { OfferContext } from './context.js';
import { currentEntryIds, findOfferByPendingEntry } from './entry-link.js';
import { audit, facts, save, type OfferRow } from './service.js';
import { inboundEmploymentContext, type OfferSyncContext } from './sync-lock.js';
import { present, profilePatch } from './sync.js';

export async function readOfferLinkageSetting(tx: Tx, tenantId: string): Promise<OfferLinkageSetting> {
  const value = (await readEffectiveSetting(tx, tenantId, OFFER_LINKAGE_KEY)).value;
  return validOfferLinkageSetting(value) ? value : OFFER_LINKAGE_DEFAULT;
}

interface LiveEntry {
  readonly id: string;
  readonly employeeId: string;
  /** revision 取锁后的当前业务头值（入站命令须带当前 revision）。 */
  readonly context: EmploymentContext;
}

/**
 * Offer 关联的“活”待入职：沿记录链取最新记录（改期 / 编辑会换 ID）；业务已被手工删除则没有。先锁员工、再读业务头
 * revision，所以在员工锁内这个 revision 不会被别的任职写入改掉。
 */
async function liveEntry(tx: Tx, ctx: OfferSyncContext, offer: OfferRow): Promise<LiveEntry | null> {
  if (offer.pendingEntryBusinessId === null || offer.syncTarget !== 'pending_entry') return null;
  const id = (await currentEntryIds(tx, ctx.tenantId, [offer])).get(offer.id)!;
  const [owner] = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`SELECT employee_id::text AS "employeeId" FROM employment_business_objects
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`),
  );
  if (!owner) return null;
  await lockEmploymentEmployee(tx, inboundEmploymentContext(ctx, 0), owner.employeeId);
  const [head] = rowsOf<{ revision: number; state: string | null }>(
    await tx.execute(sql`SELECT b.revision, (SELECT e.state FROM employment_state_events e
        WHERE e.tenant_id = b.tenant_id AND e.business_id = b.id ORDER BY e.event_no DESC LIMIT 1) AS state
      FROM employment_business_objects b WHERE b.tenant_id = ${ctx.tenantId} AND b.id = ${id}::uuid`),
  );
  if (!head || head.state === 'deleted') return null;
  return { id, employeeId: owner.employeeId, context: inboundEmploymentContext(ctx, head.revision) };
}

/** 取消关联的待入职（转已拒绝 / 已发退回待发，OF-R4）；不回调 onEntryCancelled，原因取拒绝原因（同一套 5 项编码）。 */
export async function cancelLinkedEntry(
  tx: Tx,
  ctx: OfferSyncContext,
  offer: OfferRow,
  reason?: { readonly code?: string | null; readonly remark?: string | null },
): Promise<boolean> {
  const live = await liveEntry(tx, ctx, offer);
  if (!live) return false;
  const known = ['compensation', 'growth', 'better_offer', 'personal', 'other'] as const;
  const code = known.find((item) => item === reason?.code) ?? 'other';
  await cancelPendingEntryForOfferRefusal(tx, live.context, live.id, {
    reason: code,
    ...(reason?.remark ? { remark: reason.remark } : {}),
  });
  return true;
}

/** 失效删除关联的待入职（OF-R7，不可恢复；人员主档保留）。 */
export async function deleteLinkedEntry(tx: Tx, ctx: OfferSyncContext, offer: OfferRow): Promise<boolean> {
  const live = await liveEntry(tx, ctx, offer);
  if (!live) return false;
  await deletePendingEntry(tx, live.context, live.id);
  return true;
}

export type OfferPush = 'pushed' | 'unchanged' | 'skipped' | { readonly failed: { reason: string; message: string } };

/** OF-R1 映射里随编辑推送的任职 / 试用期 / 合同字段（Offer 没填的项不覆盖待入职上已有的值）。 */
function entryChange(offer: OfferRow) {
  return {
    effectiveDate: offer.plannedEntryDate!,
    fields: present({
      departmentId: offer.departmentId,
      postId: offer.postId,
      levelId: offer.levelId,
      place: offer.workPlace,
      positionId: offer.positionId,
      directManagerId: offer.directManagerId,
      dottedManagerId: offer.dottedManagerId,
    }) as Record<string, string>,
    probation: offer.hasProbation,
    probationMonths: offer.hasProbation ? offer.probationMonths : null,
    contract: {
      startDate: offer.plannedEntryDate!,
      endDate: offer.contractEndDate,
      companyId: offer.contractCompanyId,
    },
  };
}

/**
 * 编辑并同步（OF-R14，F-171⑤）：已同步且未取消入职的待入职，把 after（编辑后的整行）推送过去——员工信息（姓名 / 邮箱 /
 * 手机 / 证件等变化项）、任职记录字段、计划入职日、试用期、合同。没有关联 / 已取消 / 已手工删除 → skipped；没有差异 → unchanged。
 * 推送在保存点里：业务规则拒绝回滚推送、给出原因（同 #407 的同步失败口径，Offer 本身的编辑保留），其他错误原样抛出整笔回滚。
 */
export async function pushEditToEntry(
  tx: Tx,
  ctx: OfferContext,
  before: OfferRow,
  after: OfferRow,
): Promise<OfferPush> {
  const live = await liveEntry(tx, ctx, after);
  if (!live || !after.plannedEntryDate) return 'skipped';
  try {
    return await tx.transaction(async (savepoint) => {
      const changed = Object.fromEntries(
        Object.entries(profilePatch(after)).filter(([key, value]) => profilePatch(before)[key] !== value),
      );
      if (Object.keys(changed).length)
        await appendEmployee(savepoint, { ...ctx, expectedRevision: 0 }, live.employeeId, changed, false);
      const pushed = await pushOfferToPendingEntry(savepoint, live.context, live.id, entryChange(after));
      if (pushed === 'cancelled') return 'skipped';
      return pushed !== 'unchanged' || Object.keys(changed).length ? 'pushed' : 'unchanged';
    });
  } catch (error) {
    const failure = ruleRejection(error);
    if (!failure) throw error;
    const { code, message, rule } = failure.detail as { code: string; message: string; rule: string | null };
    return { failed: { reason: rule ?? code, message } };
  }
}

/** 联动里 Offer 自己的状态变化（系统触发）：同事务写 Offer 与审计。 */
const systemSave = (tx: Tx, ctx: OfferSyncContext, before: OfferRow, action: string, patch: Partial<OfferRow>) =>
  save(tx, ctx as OfferContext, before, action, patch);

/**
 * 待入职 ↔ Offer 联动端口的 Offer 侧实现（entry-offer-hooks.ts，F-201①），由 offer/transitions.ts 在装配时登记。
 * - beforeEntryAction：取消 / 改期 / 办理入职开始、任何员工 / 业务 / 组织锁之前先锁住关联的 Offer（锁序 Offer → 员工 → 业务 → 组织）；
 * - onEntryCancelled（OF-R9，AC-OF-03）：开关开时，已发 / 已接受的 Offer 改已拒绝（拒绝时间 = 租户当天，原因“其他原因”）；
 * - onEntryCompleted：已发 / 已接受的 Offer 改已入职；
 * - onEntryRestored：取消的待入职经改期恢复会换新记录 ID，关联换到新 ID；已拒绝的 Offer 回到已接受（拒绝时间 / 原因 / 备注保留，
 *   DEC-532①；从已发拒绝的没有接受时间，补租户当天以满足已接受必有接受时间）。拟入职日期不跟着改期变（R2e9 / DEC-546）。
 */
export const offerEntryHooks: EntryOfferHooks = {
  beforeEntryAction: async (tx, ctx, event) => {
    await findOfferByPendingEntry(tx, ctx.tenantId, event.businessId, { lock: true });
  },
  onEntryCancelled: async (tx, ctx, event) => {
    const offer = await findOfferByPendingEntry(tx, ctx.tenantId, event.businessId, { lock: true });
    if (!offer || !offerRejectsOnEntryCancel(await readOfferLinkageSetting(tx, ctx.tenantId), facts(offer))) return;
    await systemSave(tx, ctx, offer, 'entry_cancel', {
      status: 'rejected',
      refusalTime: tenantLocalDate(ctx.now, ctx.timezone),
      refusalReasonCode: OFFER_ENTRY_CANCEL_REFUSAL_REASON,
      refusalRemark: '取消入职，联动改为已拒绝',
    });
  },
  onEntryCompleted: async (tx, ctx, event) => {
    const offer = await findOfferByPendingEntry(tx, ctx.tenantId, event.businessId, { lock: true });
    if (offer && ['sent', 'accepted'].includes(offer.status))
      await systemSave(tx, ctx, offer, 'entry_complete', { status: 'onboarded' });
  },
  onEntryRestored: async (tx, ctx, event) => {
    // 同步记录 A → 普通改期 B（不调端口）→ 取消 B → 改期恢复 C：Offer 存的仍是 A，沿记录链从 B 找回关联的 Offer，加锁后换成 C
    const before = await findOfferByPendingEntry(tx, ctx.tenantId, event.previousBusinessId, { lock: true });
    if (!before) return;
    const relink =
      before.pendingEntryBusinessId === event.businessId ? {} : { pendingEntryBusinessId: event.businessId };
    const restore =
      before.status === 'rejected'
        ? { status: 'accepted', acceptTime: before.acceptTime ?? tenantLocalDate(ctx.now, ctx.timezone) }
        : {};
    if (!Object.keys(relink).length && !Object.keys(restore).length) return;
    const [after] = await tx
      .update(offers)
      .set({ ...relink, ...restore, revision: before.revision + 1, updatedAt: ctx.now })
      .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, before.id)))
      .returning();
    await audit(tx, ctx, Object.keys(restore).length ? 'entry_restore' : 'entry_relink', before.id, before, after!);
  },
};
