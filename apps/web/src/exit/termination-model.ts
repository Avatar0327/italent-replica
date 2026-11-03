import {
  EXIT_TERMINATION_FIXED,
  EXIT_TERMINATION_FLOW_CODES,
  EXIT_TERMINATION_FLOWS,
  EXIT_TERMINATION_SETTING_KEY,
  exitTerminationPolicy,
  validExitTerminationSetting,
  type ExitTerminationGroup,
  type ExitTerminationSetting,
} from '@italent/domain';
import type { Values } from '../foundation/forms/store.js';
import { settingPath, type Setting } from './settings-model.js';
import { terminationMessages as t } from './termination-messages.js';

export const TERMINATION_TAB = 'termination-flows';
export const TERMINATION_PATH = settingPath(EXIT_TERMINATION_SETTING_KEY);
export const TERMINATION_FIELDS = EXIT_TERMINATION_FLOW_CODES.filter((code) => !EXIT_TERMINATION_FIXED.includes(code));
export const TERMINATION_LABELS = Object.fromEntries(
  EXIT_TERMINATION_FLOW_CODES.map((code) => [code, EXIT_TERMINATION_FLOWS[code].name]),
);
// Set 保持共享目录中首次出现的分组及各流程的顺序，不维护第二份流程目录。
export const TERMINATION_GROUPS = [
  ...new Set(EXIT_TERMINATION_FLOW_CODES.map((code) => EXIT_TERMINATION_FLOWS[code].group)),
].map((group: ExitTerminationGroup) => ({
  group,
  codes: EXIT_TERMINATION_FLOW_CODES.filter((code) => EXIT_TERMINATION_FLOWS[code].group === group),
}));
export type TerminationSetting = Setting<ExitTerminationSetting>;

/** 信封损坏是读取失败；流程映射缺键才按领域预置补齐，固定项始终勾选（DEC-725 / F-430）。 */
export function parseTermination(raw: unknown): TerminationSetting {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t.invalidRead);
  const row = raw as Record<string, unknown>;
  const value = row.value;
  if (
    row.key !== EXIT_TERMINATION_SETTING_KEY ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 0 ||
    !Number.isSafeInteger(row.systemVersion) ||
    (row.systemVersion as number) < 1 ||
    (row.source !== 'system' && row.source !== 'tenant') ||
    typeof row.overridable !== 'boolean' ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.entries(value).every(([code, on]) => Object.hasOwn(EXIT_TERMINATION_FLOWS, code) && typeof on === 'boolean')
  )
    throw new Error(t.invalidRead);
  return {
    value: exitTerminationPolicy(value),
    revision: row.revision as number,
    source: row.source as 'system' | 'tenant',
    overridable: row.overridable,
  };
}
export function parseTerminationReceipt(raw: unknown, revision: number) {
  const setting = parseTermination(raw);
  if (
    setting.revision !== revision + 1 ||
    setting.source !== 'tenant' ||
    !validExitTerminationSetting((raw as Record<string, unknown>).value)
  )
    throw new Error(t.invalidReceipt);
  return { id: EXIT_TERMINATION_SETTING_KEY };
}
// 可覆盖性一起进入内核 latest；冲突后系统改为只读时即时收回提交能力。
export const terminationValues = (setting: TerminationSetting): Values => ({
  ...setting.value,
  overridable: setting.overridable,
});
/** 既有 PUT 整份替换：只合入可改的流程，其他项取内核最新全量，固定项来自领域规则。 */
export function terminationBody(full: Values, edited: Values) {
  const value = Object.fromEntries(
    EXIT_TERMINATION_FLOW_CODES.map((code) => [
      code,
      TERMINATION_FIELDS.includes(code) && Object.hasOwn(edited, code) ? edited[code] : full[code],
    ]),
  );
  return { value: exitTerminationPolicy(value) };
}
