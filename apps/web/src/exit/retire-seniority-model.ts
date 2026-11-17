// F-478 S7 “退休返聘累计司龄”两层配置（设计 §7.2）：沿用租户设置 GET / PUT /api/tenant/settings/:key，布尔值整份替换。
import type { Values } from '../foundation/forms/store.js';
import { retireSeniorityMessages as t } from './retire-seniority-messages.js';
import { settingPath, type Setting } from './settings-model.js';

export const RETIRE_SENIORITY_TAB = 'retire-rehire-seniority';
// 键由迁移 0202 登记，后端常量在 apps/api（employment/rehire-seniority.ts），前端不能引用 apps/api。
export const RETIRE_SENIORITY_KEY = 'employment.retire_rehire_accumulate_seniority';
export const RETIRE_SENIORITY_PATH = settingPath(RETIRE_SENIORITY_KEY);
export const RETIRE_SENIORITY_FIELDS = ['enabled'];
export const RETIRE_SENIORITY_LABELS = { enabled: t.title };
export type RetireSenioritySetting = Setting<boolean>;

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw);
/** 信封任一键缺失或类型不对都是读取失败，不按默认关闭补齐（补齐会让页面显示一个服务端没有的值）。 */
export function parseRetireSeniority(raw: unknown): RetireSenioritySetting {
  if (
    !isRecord(raw) ||
    raw.key !== RETIRE_SENIORITY_KEY ||
    typeof raw.value !== 'boolean' ||
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    (raw.source !== 'system' && raw.source !== 'tenant') ||
    typeof raw.overridable !== 'boolean'
  )
    throw new Error(t.invalidRead);
  return { value: raw.value, revision: raw.revision as number, source: raw.source, overridable: raw.overridable };
}
/** 回执须是本键的租户覆盖、版本 = 提交版本 + 1，且回显实际发送的值；否则按结果未知锁定。 */
export function parseRetireSeniorityReceipt(raw: unknown, revision: number, sent: boolean) {
  const setting = parseRetireSeniority(raw);
  if (setting.revision !== revision + 1 || setting.source !== 'tenant' || setting.value !== sent)
    throw new Error(t.invalidReceipt);
  return { id: RETIRE_SENIORITY_KEY };
}
// 可覆盖性一起进入内核 latest：冲突重读后系统改为只读时即时收回提交能力（同 termination-model.ts）。
export const retireSeniorityValues = (setting: RetireSenioritySetting): Values => ({
  enabled: setting.value,
  overridable: setting.overridable,
});
/** PUT 体只有 value；未编辑时取内核最新值。 */
export const retireSeniorityBody = (full: Values, edited: Values) => ({
  value: (Object.hasOwn(edited, 'enabled') ? edited.enabled : full.enabled) === true,
});
