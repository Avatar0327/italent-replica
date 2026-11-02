/**
 * FE-R2c1b 试用设置页的纯规则：试用结果字典、自动转正（B57）/ 自动发起考核（B58）规则、两个总开关与考核并行规则（B59）。
 * 后端：employment/probation-routes.ts（字典）、auto-regularization-routes.ts / auto-assessment-routes.ts（规则与立即执行）、
 * tenant-settings/routes.ts（两层配置）。本文件被页面与 vitest 引用，不依赖 React 或浏览器 API；权威校验在服务端。
 */
import {
  ASSESSMENT_TYPES,
  AUTO_ASSESSMENT_DAYS_MAX,
  AUTO_ASSESSMENT_DAYS_MESSAGE,
  AUTO_ASSESSMENT_DAYS_MIN,
  AUTO_ASSESSMENT_SETTING_KEY,
  AUTO_REGULARIZATION_DAYS_MAX,
  AUTO_REGULARIZATION_DAYS_MESSAGE,
  AUTO_REGULARIZATION_DAYS_MIN,
  AUTO_REGULARIZATION_MODES,
  AUTO_REGULARIZATION_SETTING_KEY,
  AUTO_RULE_INITIATORS,
  PARALLEL_CANDIDATES,
  PARALLEL_RULE_KEYS,
  isParallelRuleValue,
  type ParallelRuleBlocker,
} from '@italent/domain';
import type { MenuNode } from '../foundation/permission-snapshot.js';
import type { ObjectPermission } from '../foundation/permission-model.js';
import type { Values } from '../foundation/forms/store.js';
import { s } from './settings-messages.js';

const ROOT = '/api/tenant/employment';
/** 字典与规则的写入都按任职设置配置对象授权；配置写别名映射到管理员能力 other_settings（policy.ts）。 */
export const SETTINGS_OBJECT = 'TenantBase.EmploymentSettings';
export const OTHER_SETTINGS_MENU = 'other.mou_settings';
export const RESULTS_PATH = `${ROOT}/probation-results`;
/** 两层配置集合：内核按“集合 + 键”成恢复槽。 */
export const SETTINGS_RESOURCE = '/api/tenant/settings';
export const settingPath = (key: string) => `${SETTINGS_RESOURCE}/${encodeURIComponent(key)}`;
export const TABS = ['results', 'auto-regularization', 'auto-assessment', 'parallel'] as const;
export type Tab = (typeof TABS)[number];
export const isTab = (value: string | undefined): value is Tab => (TABS as readonly string[]).includes(value ?? '');

// ───────────── 权限 ─────────────
const loadedOf = (permission?: ObjectPermission) => (permission && !permission.summary ? permission : undefined);
/** “管理单元设置”菜单可编辑 = 持有 other_settings（同 F-327 accountStopWritable）。 */
export function otherSettingsEditable(menus: readonly MenuNode[]) {
  const settings = menus.find((menu) => menu.key === 'settings')?.children ?? [];
  return settings.find((menu) => menu.key === OTHER_SETTINGS_MENU)?.editable === true;
}
const fieldEditable = (loaded: ObjectPermission | undefined, field: string) =>
  !!loaded && loaded.viewableFields.includes(field) && loaded.editableFields.includes(field);

// ───────────── 试用结果字典 ─────────────
export const CODE_MAX = 100;
export const NAME_MAX = 200;
export const ORDER_MAX = 100000;
export type Result = {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  displayOrder: number;
  revision: number;
};
export const resultFields = ['code', 'name', 'enabled', 'displayOrder'] as const;
const resultUpdatable = ['name', 'enabled', 'displayOrder'] as const;
const isResult = (raw: unknown): raw is Result => {
  const row = raw as Partial<Result> | null;
  return (
    !!row &&
    typeof row.id === 'string' &&
    row.id !== '' &&
    typeof row.code === 'string' &&
    typeof row.name === 'string' &&
    typeof row.enabled === 'boolean' &&
    Number.isSafeInteger(row.displayOrder) &&
    Number.isSafeInteger(row.revision) &&
    row.revision! >= 1
  );
};
/** 字典整份返回（不裁剪，上限 200）；形态不对按读取失败处理，不当作空字典。 */
export function parseResults(raw: unknown): Result[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || !items.every(isResult)) throw new Error(s.invalidList);
  return items;
}
/** 新增 / 修改回执是整行：修改须是本行，版本 = 实际提交的版本（If-Match）+ 1。 */
export function parseResultReceipt(raw: unknown, expected: { id?: string; revision: number }) {
  if (!isResult(raw) || (expected.id && raw.id !== expected.id) || raw.revision !== expected.revision + 1)
    throw new Error(s.invalidReceipt);
  return { id: raw.id };
}
/**
 * 字典写能力（fail-closed）：任职设置对象明细已加载 + 数据操作 + 字段可见可编辑，并且持有 other_settings。
 * 新增须编码、名称都可编辑；修改按字段逐项（改名 / 启停 / 显示顺序各看各的）。
 */
export function resultAccess(permission: ObjectPermission | undefined, menus: readonly MenuNode[]) {
  const loaded = otherSettingsEditable(menus) ? loadedOf(permission) : undefined;
  const editable = (field: string) => fieldEditable(loaded, field);
  const createFields = loaded?.dataOperations.create === true ? resultFields.filter(editable) : [];
  const create = createFields.includes('code') && createFields.includes('name');
  return {
    create,
    createFields: create ? createFields : [],
    updateFields: loaded?.dataOperations.update === true ? resultUpdatable.filter(editable) : [],
  };
}
export type ResultAccess = ReturnType<typeof resultAccess>;
/** 新增默认排在最后：末项显示顺序 + 10。 */
export function nextOrder(rows: readonly Result[]) {
  const last = rows.reduce((max, row) => Math.max(max, row.displayOrder), 0);
  return rows.length ? Math.min(ORDER_MAX, last + 10) : 10;
}
/** 编码查重不分大小写（后端 lower(code)）。 */
export const sameCode = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

// ───────────── 自动规则（B57 / B58） ─────────────
export type RuleKind = 'regularization' | 'assessment';
const common = ['name', 'priority', 'orgIds', 'includeSubordinates', 'initiatorType', 'enabled'] as const;
export const RULES = {
  regularization: {
    tab: 'auto-regularization',
    path: `${ROOT}/auto-regularization-rules`,
    run: `${ROOT}/auto-regularization/run`,
    setting: AUTO_REGULARIZATION_SETTING_KEY,
    fields: [...common, 'mode', 'daysBefore', 'probationResult'],
    days: 'daysBefore',
    daysMin: AUTO_REGULARIZATION_DAYS_MIN,
    daysMax: AUTO_REGULARIZATION_DAYS_MAX,
    daysMessage: AUTO_REGULARIZATION_DAYS_MESSAGE,
    nameMax: 100,
    business: 'businessId',
  },
  assessment: {
    tab: 'auto-assessment',
    path: `${ROOT}/auto-assessment-rules`,
    run: `${ROOT}/auto-assessment/run`,
    setting: AUTO_ASSESSMENT_SETTING_KEY,
    fields: [...common, 'assessmentType', 'daysAfterEntry'],
    days: 'daysAfterEntry',
    daysMin: AUTO_ASSESSMENT_DAYS_MIN,
    daysMax: AUTO_ASSESSMENT_DAYS_MAX,
    daysMessage: AUTO_ASSESSMENT_DAYS_MESSAGE,
    nameMax: 100,
    business: 'assessmentId',
  },
} as const;
export const RULE_OPTIONS = {
  mode: AUTO_REGULARIZATION_MODES as Record<string, string>,
  initiatorType: AUTO_RULE_INITIATORS as Record<string, string>,
  assessmentType: ASSESSMENT_TYPES as Record<string, string>,
};
export const ORG_MAX = 50;
export const PRIORITY_MAX = 9999;
/** 规则行：id / 版本必有；其余字段按查看权裁剪，可能缺省（显示占位，不可编辑）。 */
export type Rule = { id: string; revision: number } & Values;

const isInt = (value: unknown) => Number.isSafeInteger(value);
const isText = (value: unknown) => typeof value === 'string';
const inOptions = (options: Record<string, string>) => (value: unknown) => isText(value) && value! in options;
const RULE_CHECKS: Record<string, (value: unknown) => boolean> = {
  name: isText,
  priority: isInt,
  orgIds: (value) => Array.isArray(value) && value.every(isText),
  includeSubordinates: (value) => typeof value === 'boolean',
  mode: inOptions(RULE_OPTIONS.mode),
  daysBefore: isInt,
  daysAfterEntry: isInt,
  initiatorType: inOptions(RULE_OPTIONS.initiatorType),
  assessmentType: inOptions(RULE_OPTIONS.assessmentType),
  probationResult: isText,
  enabled: (value) => typeof value === 'boolean',
  operatorUserId: isText,
};
const isRule = (raw: unknown): raw is Rule => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id === '' || !isInt(row.revision) || (row.revision as number) < 1) return false;
  return Object.entries(RULE_CHECKS).every(([field, check]) => !(field in row) || check(row[field]));
};
export function parseRules(raw: unknown): Rule[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || !items.every(isRule)) throw new Error(s.invalidList);
  return items;
}
/** 新增 / 编辑 / 复制 / 启停的回执都是（裁剪后的）整条规则：版本 = 实际提交的版本 + 1；新增与复制不核对 id。 */
export function parseRuleReceipt(raw: unknown, expected: { id?: string; revision: number }) {
  if (!isRule(raw) || (expected.id && raw.id !== expected.id) || raw.revision !== expected.revision + 1)
    throw new Error(s.invalidReceipt);
  return { id: raw.id };
}
/** 删除回执 { id, deleted: true }。 */
export function parseDeleteReceipt(raw: unknown, id: string) {
  const body = raw as { id?: unknown; deleted?: unknown } | null;
  if (!body || body.id !== id || body.deleted !== true) throw new Error(s.invalidReceipt);
  return { id };
}
/** 本行有字段被裁剪：不能整份提交，编辑入口关闭。 */
export const ruleTrimmed = (kind: RuleKind, rule: Rule) => RULES[kind].fields.some((field) => !(field in rule));
export const ruleValues = (kind: RuleKind, rule: Values): Values =>
  Object.fromEntries(RULES[kind].fields.filter((field) => field in rule).map((field) => [field, rule[field]]));

/**
 * 编辑是整份严格替换（PUT，enabled / includeSubordinates / probationResult 缺省会被后端默认值覆盖）：
 * 内核只给出改过的字段，未改项取最新全量，整理成规则的全部字段后提交。
 */
export function ruleBody(kind: RuleKind, full: Values, edited: Values) {
  const merged: Values = { ...full, ...edited };
  const body: Values = {};
  for (const field of RULES[kind].fields) {
    const value = merged[field];
    body[field] = typeof value === 'string' ? value.trim() : value;
  }
  return body;
}

/**
 * 规则写能力（fail-closed，同命令内复核 ruleGuard）：other_settings + 对象明细已加载。
 * 新增 / 编辑整份提交，须全部字段可编辑；复制只看新增操作，启停看 enabled，删除与立即执行沿用修改操作（commandOnly）。
 */
export function ruleAccess(kind: RuleKind, permission: ObjectPermission | undefined, menus: readonly MenuNode[]) {
  const loaded = otherSettingsEditable(menus) ? loadedOf(permission) : undefined;
  const all = RULES[kind].fields.every((field) => fieldEditable(loaded, field));
  const create = loaded?.dataOperations.create === true;
  const update = loaded?.dataOperations.update === true;
  return {
    create: create && all,
    update: update && all,
    copy: create,
    toggle: update && fieldEditable(loaded, 'enabled'),
    remove: update,
    run: update,
  };
}
export type RuleAccess = ReturnType<typeof ruleAccess>;

// ───────────── 立即执行回执 ─────────────
export interface RunReceipt {
  businessDate: string;
  launched: { employeeId: string; ruleId: string; businessRef: string }[];
  failed: { employeeId: string; ruleId: string; reason: string }[];
  nextCursor: string | null;
}
const isItem = (raw: unknown, keys: readonly string[]) =>
  !!raw && typeof raw === 'object' && keys.every((key) => isText((raw as Record<string, unknown>)[key]));
/** 回执 { businessDate, launched, failed, nextCursor }；launched 的业务单据键按规则类型（businessId / assessmentId）。 */
export function parseRunReceipt(kind: RuleKind, raw: unknown): RunReceipt {
  const body = raw as Partial<Record<keyof RunReceipt, unknown>> | null;
  const business = RULES[kind].business;
  const launched = body?.launched;
  const failed = body?.failed;
  if (
    !body ||
    !isText(body.businessDate) ||
    !Array.isArray(launched) ||
    !launched.every((item) => isItem(item, ['employeeId', 'ruleId', business])) ||
    !Array.isArray(failed) ||
    !failed.every((item) => isItem(item, ['employeeId', 'ruleId', 'reason'])) ||
    !(body.nextCursor === null || isText(body.nextCursor))
  )
    throw new Error(s.runInvalid);
  return {
    businessDate: body.businessDate as string,
    launched: launched.map((item: Record<string, string>) => ({
      employeeId: item.employeeId!,
      ruleId: item.ruleId!,
      businessRef: item[business]!,
    })),
    failed: failed.map((item: Record<string, string>) => ({
      employeeId: item.employeeId!,
      ruleId: item.ruleId!,
      reason: item.reason!,
    })),
    nextCursor: body.nextCursor as string | null,
  };
}

// ───────────── 两层配置：总开关与并行规则 ─────────────
export type Setting = {
  key: string;
  value: unknown;
  source: 'system' | 'tenant';
  revision: number;
  systemVersion: number;
  overridable: boolean;
};
const SETTING_KEYS = ['key', 'overridable', 'revision', 'source', 'systemVersion', 'value'].join();
export const isSwitchValue = (value: unknown) => typeof value === 'boolean';
const isSetting = (raw: unknown, key: string, valid: (value: unknown) => boolean): raw is Setting => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const row = raw as Partial<Setting>;
  return (
    Object.keys(row).sort().join() === SETTING_KEYS &&
    row.key === key &&
    valid(row.value) &&
    (row.source === 'system' || row.source === 'tenant') &&
    isInt(row.revision) &&
    row.revision! >= 0 &&
    isInt(row.systemVersion) &&
    typeof row.overridable === 'boolean'
  );
};
/** GET 回显恰好六个键、键名一致、取值合法，否则按读取失败处理，不当作默认值。 */
export function parseSetting(raw: unknown, key: string, valid: (value: unknown) => boolean): Setting {
  if (!isSetting(raw, key, valid)) throw new Error(s.invalidRead);
  return raw;
}
/** PUT 回执同形：版本 = 实际提交的版本 + 1，来源变为租户覆盖。 */
export function parseSettingReceipt(raw: unknown, key: string, valid: (value: unknown) => boolean, revision: number) {
  if (!isSetting(raw, key, valid) || raw.revision !== revision + 1 || raw.source !== 'tenant')
    throw new Error(s.invalidReceipt);
  return { id: key };
}
/**
 * 配置写能力（fail-closed）：other_settings + 任职设置对象有修改权（同 F-327 先例），且该配置允许租户覆盖。
 * 配置值没有字段目录，不看 editableFields。
 */
export function settingWritable(
  permission: ObjectPermission | undefined,
  menus: readonly MenuNode[],
  setting: Pick<Setting, 'overridable'>,
) {
  return loadedOf(permission)?.dataOperations.update === true && otherSettingsEditable(menus) && setting.overridable;
}

export const PARALLEL_BLOCKERS = Object.keys(PARALLEL_RULE_KEYS) as ParallelRuleBlocker[];
export const parallelKey = (blocker: ParallelRuleBlocker) => PARALLEL_RULE_KEYS[blocker];
export const parallelCandidates = (blocker: ParallelRuleBlocker) => PARALLEL_CANDIDATES[blocker];
export const parallelValid = (blocker: ParallelRuleBlocker) => (value: unknown) => isParallelRuleValue(blocker, value);
/**
 * 并行规则整份提交 { enabled, allowed }：关闭时多选隐藏，按关闭提交 allowed = []，不把隐藏的旧勾选带回去；
 * 勾选按候选顺序排列、去重，非候选值剔除。
 */
export function parallelBody(blocker: ParallelRuleBlocker, full: Values, edited: Values) {
  const merged = { ...full, ...edited };
  const enabled = merged.enabled === true;
  const picked = Array.isArray(merged.allowed) ? (merged.allowed as unknown[]) : [];
  const allowed = enabled ? PARALLEL_CANDIDATES[blocker].filter((item) => picked.includes(item)) : [];
  return { enabled, allowed };
}
