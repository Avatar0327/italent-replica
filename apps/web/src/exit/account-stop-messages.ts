// F-327 账号停用时间配置页文案（DEC-045）。另起文件：离职模块 messages.ts 有在途片同时追加。
// 术语沿用 docs/02_业务建模/30 DM-R9（“实际离岗日”“最后工作日”“审批中也停用”）。
export const a = {
  tab: '账号停用时间',
  intro: '离职员工的系统账号默认在离职生效时停用；开启提前停用后，按下面的日期与时间停用。',
  earlyEnabled: '提前停用账号',
  basis: '停用依据',
  basisOptions: { actual_leave_date: '实际离岗日', last_work_date: '最后工作日' },
  basisHint: '实际离岗日未填写时按最后工作日。',
  time: '停用时间',
  timeHint: '24 小时制，按租户时区；到达该日期的这一时刻即停用账号。',
  timeFormat: '请输入 00:00～23:59 的时间，格式 HH:mm',
  inReview: '审批中也停用',
  inReviewHint: '只在开启提前停用时生效：离职审批尚未通过，到达停用时间也停用账号。',
  required: '必填',
  save: '保存',
  saved: '账号停用时间已保存',
  unchanged: '没有需要保存的改动',
  invalidRead: '账号停用配置读取结果无效，请刷新后重试',
  invalidReceipt: '保存回执无效，请刷新后核对',
};
