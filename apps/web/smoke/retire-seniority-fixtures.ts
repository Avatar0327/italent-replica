// F-478 S7：“退休返聘累计司龄”两层配置的真实信封，由 AC-EMP-F478-27.contract 用 HTTP 响应逐键核对；不依赖 Playwright。
// 设置键由迁移 0202 登记，后端常量在 apps/api（employment/rehire-seniority.ts），前端不能引用 apps/api，这里按信封原文写。
export const retireSeniorityDefault = {
  key: 'employment.retire_rehire_accumulate_seniority',
  value: false as boolean,
  source: 'system' as 'system' | 'tenant',
  revision: 0,
  systemVersion: 1,
  overridable: true,
};
export const retireSeniorityConflict = {
  error: { code: 'REVISION_CONFLICT', message: '配置已被他人修改，请刷新后重试' },
};
