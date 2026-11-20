/**
 * 签署来源事件与锁序（F-505 设计 §5、§6.2；纯函数，无 IO）。
 * Offer 与待入职记录的写入口只发这里定义的事件，S1 没有业务订阅方；订阅方（S2 / S3 的撤销服务）按名称登记。
 * 事件只表达“来源发生了什么”，不带人员字段、不带 Offer 的个人信息。
 */
import type { SignRevokeCause } from './events.js';

export type ESignSourceKind = 'offer' | 'entry';

/**
 * deleted：来源被物理删除或被替换（待入职改期 / 换日期会删旧记录建新记录）；
 * left_signable：来源离开可签状态（Offer 退出已接受 / 已入职，待入职被取消）；
 * changed：来源在可签状态下改了业务字段（revision 变化）。
 */
export type ESignSourceChange = 'deleted' | 'left_signable' | 'changed';

export interface ESignSourceEvent {
  readonly source: ESignSourceKind;
  /** Offer ID 或待入职业务 ID。 */
  readonly sourceId: string;
  readonly change: ESignSourceChange;
  /** 事件后来源的 revision；已物理删除的来源为 null。 */
  readonly revision: number | null;
}

/** 订阅方可用的上下文：只给租户、操作人与时间。 */
export interface ESignSourceEventContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly timezone: string;
  readonly now: Date;
  readonly commandId: string;
}

/** 事件对应的任务撤销原因（revoke_cause，F-505 设计 §4.2）：物理删除沿用 business_deleted。 */
export const SOURCE_REVOKE_CAUSE: Readonly<Record<ESignSourceChange, SignRevokeCause>> = {
  deleted: 'business_deleted',
  left_signable: 'source_cancelled',
  changed: 'source_changed',
};

/** Offer 处于“可签”的状态：已接受 / 已入职（设计 §3）。审批子状态不影响可签性。 */
const SIGNABLE_OFFER_STATUSES: readonly string[] = ['accepted', 'onboarded'];
export const isOfferSignable = (status: string): boolean => SIGNABLE_OFFER_STATUSES.includes(status);

export interface OfferSourceFacts {
  readonly status: string;
  readonly revision: number;
}

/**
 * Offer 一次写入前后的来源变化：after 为 null 表示物理删除。进入可签、离开审批子状态等不影响来源的写入返回 null。
 * 离开可签优先于字段变更：同一次写入既改字段又退出可签，只发 left_signable。
 */
export function classifyOfferChange(
  before: OfferSourceFacts,
  after: OfferSourceFacts | null,
  fieldsChanged: boolean,
): ESignSourceChange | null {
  if (after === null) return 'deleted';
  if (!isOfferSignable(before.status)) return null;
  if (!isOfferSignable(after.status)) return 'left_signable';
  return fieldsChanged ? 'changed' : null;
}

/** 取锁分类，固定顺序即锁序（设计 §5）：Offer 行 → 员工闭包 → 任职业务 → 组织 / 编制 → 签署任务（ID 升序）。 */
export const SOURCE_LOCK_ORDER = ['offer', 'employee', 'business', 'org', 'task'] as const;
export type SourceLockClass = (typeof SOURCE_LOCK_ORDER)[number];

/** 已持有 held 之后再取 next 是否倒序：只能向后取锁，倒序会与正向事务互等。 */
export function isLockOrderViolation(held: readonly SourceLockClass[], next: SourceLockClass): boolean {
  const rank = SOURCE_LOCK_ORDER.indexOf(next);
  return held.some((lock) => SOURCE_LOCK_ORDER.indexOf(lock) > rank);
}
