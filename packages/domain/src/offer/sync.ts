/**
 * Offer → 待入职同步的纯规则（R2 BE-14b2；docs/02_业务建模/34 OF-R1 / R8，DEC-532⑤）。
 * 同步时机设置（OF-R8）、按时机判定该不该自动同步、同步类型（社招 / 校招 = 内部员工 + 劳动合同，实习 = 实习生 + 实习协议）。
 */
import { effectiveOfferType, type OfferStatus, type OfferType } from './rules.js';

/** 同步状态（SyncStatus，34 文末映射）：未同步为空，成功 / 失败。 */
export const OFFER_SYNC_STATUSES = ['success', 'failed'] as const;
export type OfferSyncStatus = (typeof OFFER_SYNC_STATUSES)[number];

export const OFFER_SYNC_TIMING_KEY = 'offer.sync_timing';
export const OFFER_SYNC_MODES = ['on_send', 'on_accept', 'on_accept_within_days'] as const;
export type OfferSyncMode = (typeof OFFER_SYNC_MODES)[number];
export const OFFER_SYNC_DAYS = { min: 1, max: 90 } as const;

export interface OfferSyncSetting {
  /** 关闭则只能手动“立即同步”。 */
  readonly enabled: boolean;
  readonly mode: OfferSyncMode;
  /** 仅 on_accept_within_days：距计划入职日 ≤ N 天（1–90）。 */
  readonly days: number;
  /** 在职实习生的正式 Offer 是否同步；关闭时改走实习转正（已离职的实习生不受限）。 */
  readonly internConversion: boolean;
}

/** 出厂：开，接受时，30 天（OF-R8 默认开、N 默认 30；在职实习生 Offer 开关原站默认未知，取开）。 */
export const OFFER_SYNC_DEFAULT: OfferSyncSetting = {
  enabled: true,
  mode: 'on_accept',
  days: 30,
  internConversion: true,
};

export function validOfferSyncSetting(value: unknown): value is OfferSyncSetting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 4 &&
    typeof v.enabled === 'boolean' &&
    typeof v.internConversion === 'boolean' &&
    (OFFER_SYNC_MODES as readonly unknown[]).includes(v.mode) &&
    Number.isInteger(v.days) &&
    (v.days as number) >= OFFER_SYNC_DAYS.min &&
    (v.days as number) <= OFFER_SYNC_DAYS.max
  );
}

/** 距计划入职日的整天数（含负数：日期已过）。 */
export const daysUntil = (date: string, today: string): number =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

/**
 * 自动同步判定（发送 / 接受 / 夜间任务共用）：on_send 在已发、已接受时到期；on_accept 在已接受时到期；
 * on_accept_within_days 在已接受且距入职日 ≤ N 天时到期（含日期已过）。手动“立即同步”不看时机，只看 offerManualSyncable。
 */
export function offerSyncDue(
  setting: OfferSyncSetting,
  offer: { readonly status: string; readonly plannedEntryDate: string | null },
  today: string,
): boolean {
  if (!setting.enabled || !offer.plannedEntryDate) return false;
  if (setting.mode === 'on_send') return offer.status === 'sent' || offer.status === 'accepted';
  if (offer.status !== 'accepted') return false;
  return setting.mode === 'on_accept' || daysUntil(offer.plannedEntryDate, today) <= setting.days;
}

/** 手动立即同步：已接受；时机为“发送时”时已发也可。 */
export const offerManualSyncable = (setting: OfferSyncSetting, status: OfferStatus): boolean =>
  status === 'accepted' || (status === 'sent' && setting.mode === 'on_send');

/** 同步类型（OF-R1，DEC-532⑤）。 */
export function offerSyncKind(type: OfferType | null | undefined): {
  readonly employType: 'internal' | 'intern';
  readonly contractKind: 'labor' | 'internship_agreement';
} {
  return effectiveOfferType(type) === 'intern'
    ? { employType: 'intern', contractKind: 'internship_agreement' }
    : { employType: 'internal', contractKind: 'labor' };
}
