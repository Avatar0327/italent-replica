/**
 * 待入职状态动作的纯数据常量（R2 BE-2a；34 EN-R8 / R9，DEC-484② / F-129）。
 * 取消入职原因：原站为下拉 5 项、非必填；证据只到“5 项下拉”，是否可配置未验证，首版固定枚举（DEC-402）。
 */
export const ENTRY_CANCEL_REASONS = {
  compensation: '薪酬福利不满意',
  growth: '发展空间受限',
  better_offer: '有更好的工作机会',
  personal: '个人原因',
  other: '其他原因',
} as const;
export type EntryCancelReason = keyof typeof ENTRY_CANCEL_REASONS;
export const ENTRY_CANCEL_REASON_CODES = Object.keys(ENTRY_CANCEL_REASONS) as [
  EntryCancelReason,
  ...EntryCancelReason[],
];

/** edit = 行内编辑换日期（F-188，保持原入职状态）；postpone = 改期入职（变延期，已取消即恢复）。 */
export const ENTRY_ACTIONS = ['cancel', 'postpone', 'edit'] as const;
export type EntryAction = (typeof ENTRY_ACTIONS)[number];

/** 编辑待入职时可选的雇佣关系（R2e9 原站“内部员工 / 实习生”，取值同任职字段 employType）。 */
export const ENTRY_EDIT_EMPLOY_TYPES = ['internal', 'intern'] as const;
export type EntryEditEmployType = (typeof ENTRY_EDIT_EMPLOY_TYPES)[number];

/** 取消说明 / 改期备注的长度上限。 */
export const ENTRY_REMARK_MAX = 500;
