/**
 * F-493 §3.6 性别 / 民族 / 政治面貌选项（先红桩：常量为空、校验恒失败，真实实现在下一提交）。
 */
export const PROFILE_GENDER_OPTIONS: readonly string[] = [];
export const PROFILE_NATION_OPTIONS: readonly string[] = [];
export const PROFILE_POLITICAL_STATUS_OPTIONS: readonly string[] = [];

export type ProfileOptionCheck = { readonly ok: true; readonly value: string | null } | { readonly ok: false };

export function checkProfileOption(_options: readonly string[], _raw: string | null | undefined): ProfileOptionCheck {
  return { ok: false };
}
