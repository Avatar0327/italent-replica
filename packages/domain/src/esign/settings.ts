/** 签署场景设置的取值范围与默认值（F-481 设计 §4.1 / §5.4；原站取证：有效期 2～30 天，默认 2 天，到期前提醒默认不勾）。 */

export const ESIGN_SCENES = ['transfer'] as const;
export type EsignScene = (typeof ESIGN_SCENES)[number];

export const ESIGN_VALIDITY_DAYS_MIN = 2;
export const ESIGN_VALIDITY_DAYS_MAX = 30;
export const ESIGN_DEFAULT_VALIDITY_DAYS = 2;
export const ESIGN_DEFAULT_REMIND_BEFORE_EXPIRY = false;

export function isValidValidityDays(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= ESIGN_VALIDITY_DAYS_MIN &&
    (value as number) <= ESIGN_VALIDITY_DAYS_MAX
  );
}

/** 有效期按小时计：发起时刻 + N × 24 小时，不按租户日历日（设计 §5.4，D9）。 */
export function esignExpiresAt(initiatedAt: Date, validityDays: number): Date {
  return new Date(initiatedAt.getTime() + validityDays * 24 * 60 * 60 * 1000);
}
