// F-327 账号停用时间配置页的冒烟夹具：形态与真实接口一致（AC-FE-F327-account-stop 用真实接口核对）。
// 本文件不引用 playwright，供 vitest 直接读取；数据全部为合成值。

/** GET /exit-account/settings 未保存过时的默认值（exit-account-store.ts defaultAccountSettings，DEC-685④ 默认关）。 */
export const accountStopDefault = {
  earlyEnabled: false,
  basis: null,
  time: null,
  inReview: false,
  revision: 0,
} as { earlyEnabled: boolean; basis: string | null; time: string | null; inReview: boolean; revision: number };

/** 租户管理员快照里 other_settings 对应的企业设置菜单（enterprise-menus.ts），前端据此判断能否保存。 */
export const otherSettingsMenu = {
  code: 'other.mou_settings',
  path: '其他设置/管理单元设置',
  implemented: true,
  editable: true,
};

/** 严格 DTO 校验失败（如时间格式不对）的明确拒绝。 */
export const accountStopRejected = { error: { code: 'VALIDATION_FAILED', message: '账号停用配置不合法' } };
