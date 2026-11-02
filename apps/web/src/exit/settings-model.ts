// FE-R2c2b 离职设置页的纯规则：交接事项（B64，employment/exit-handover-items.ts）、交接发起规则（B65，租户设置
// exit.handover_trigger）、黑名单（B68，employment/blacklist.ts）与自动加黑规则（blacklist-rules.ts）。
// 本文件被页面与 vitest 引用，不依赖 React 或浏览器 API；权威校验仍在服务端。B63 终止在途设置没有接口，不做。
import {
  AUTO_BLACKLIST_SETTING_KEY,
  BLACKLIST_REASON_CODES,
  BLACKLIST_RULE_TERM_CODES,
  BLACKLIST_SOURCE_CODES,
  BLACKLIST_STATUSES,
  EXIT_HANDOVER_TRIGGER_KEY,
  HANDOVER_TODO_TYPE_CODES,
  HANDOVER_TRIGGER_DEFAULT,
  HANDOVER_VERIFIED_INITIATOR,
  checkHandoverTrigger,
  type HandoverTriggerSetting,
} from '@italent/domain';
import type { Values } from '../foundation/forms/store.js';
import type { MenuNode } from '../foundation/permission-snapshot.js';
import { canButton, type ObjectPermission } from '../foundation/permission-model.js';
import { s } from './settings-messages.js';

/** 页签路径段，与三个字典、账号停用时间同级（/exit-settings/<tab>）。 */
export const SETTINGS_TABS = ['handover-items', 'handover-trigger', 'blacklist', 'blacklist-rules'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const isSettingsTab = (value: string | undefined): value is SettingsTab =>
  (SETTINGS_TABS as readonly string[]).includes(value ?? '');

const EMPLOYMENT = '/api/tenant/employment';
export const HANDOVER_ITEMS_PATH = `${EMPLOYMENT}/exit-handover-items`;
export const BLACKLIST_PATH = `${EMPLOYMENT}/blacklist`;
export const BLACKLIST_RULES_PATH = `${EMPLOYMENT}/blacklist-rules`;
export const settingPath = (key: string) => `/api/tenant/settings/${key}`;
export const TRIGGER_PATH = settingPath(EXIT_HANDOVER_TRIGGER_KEY);
export const AUTO_BLACKLIST_PATH = settingPath(AUTO_BLACKLIST_SETTING_KEY);
export const BLACKLIST_OBJECT = 'TenantBase.Blacklist';
export const rowPath = (collection: string, id: string) => `${collection}/${encodeURIComponent(id)}`;

// ---- 形状校验：字段被裁剪时键缺失（trimModuleResponse 平铺裁剪），出现的键必须类型正确 ----------------------------
type Check = (value: unknown) => boolean;
const text: Check = (value) => typeof value === 'string';
const optionalText: Check = (value) => value === null || typeof value === 'string';
const integer: Check = (value) => Number.isSafeInteger(value);
const oneOf =
  (options: readonly string[]): Check =>
  (value) =>
    typeof value === 'string' && options.includes(value);
const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw);
const isCondition = (raw: unknown) =>
  isRecord(raw) && raw.field === 'exitCount' && raw.operator === 'gte' && Number.isSafeInteger(raw.value);

const ITEM_CHECKS: Record<string, Check> = {
  category: text,
  sequenceNo: integer,
  todoType: oneOf(HANDOVER_TODO_TYPE_CODES),
  title: text,
  formRef: optionalText,
  remark: optionalText,
};
const RULE_CHECKS: Record<string, Check> = {
  name: text,
  priority: integer,
  orgIds: (value) => Array.isArray(value) && value.every(text),
  description: optionalText,
  conditions: (value) => Array.isArray(value) && value.every(isCondition),
  term: oneOf(BLACKLIST_RULE_TERM_CODES),
  reason: oneOf(BLACKLIST_REASON_CODES),
  note: optionalText,
};
const BLACKLIST_CHECKS: Record<string, Check> = {
  employeeId: optionalText,
  name: text,
  idNumber: optionalText,
  mobilePhone: optionalText,
  email: optionalText,
  reason: oneOf(BLACKLIST_REASON_CODES),
  blacklistDate: text,
  expiryDate: optionalText,
  note: optionalText,
  source: oneOf(BLACKLIST_SOURCE_CODES),
  status: oneOf(BLACKLIST_STATUSES),
  removedAt: optionalText,
};
export type Row = Values & { id: string; revision: number };
export type Shape = 'item' | 'rule' | 'blacklist';
const CHECKS: Record<Shape, Record<string, Check>> = {
  item: ITEM_CHECKS,
  rule: RULE_CHECKS,
  blacklist: BLACKLIST_CHECKS,
};
/** 整份保存的业务字段（交接事项 / 规则），与形状校验同一份清单。 */
export const HANDOVER_ITEM_FIELDS = Object.keys(ITEM_CHECKS);
export const RULE_FIELDS = Object.keys(RULE_CHECKS);

function isRow(raw: unknown, shape: Shape): raw is Row {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return false;
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) return false;
  return Object.entries(CHECKS[shape]).every(([field, check]) => !(field in raw) || check(raw[field]));
}
/** 整份列表（交接事项上限 200、规则上限 100，不分页）：形态不对按读取失败处理，不当作空列表。 */
export function parseRows(raw: unknown, shape: Shape): Row[] {
  const items = isRecord(raw) ? raw.items : undefined;
  if (!Array.isArray(items) || !items.every((item) => isRow(item, shape))) throw new Error(s.invalidList);
  return items;
}
/** 新增 / 修改回执是整行：须是本行（新增不核对 id），版本 = 实际提交的版本 + 1，否则按结果未知处理。 */
export function parseRowReceipt(raw: unknown, shape: Shape, expected: { id?: string; revision: number }) {
  if (!isRow(raw, shape) || (expected.id && raw.id !== expected.id) || raw.revision !== expected.revision + 1)
    throw new Error(s.invalidReceipt);
  return { id: raw.id };
}
/** 交接事项 / 规则的删除回执：{ id, deleted: true }。 */
export function parseDeleteReceipt(raw: unknown, id: string) {
  if (!isRecord(raw) || raw.id !== id || raw.deleted !== true) throw new Error(s.invalidReceipt);
  return { id };
}

// ---- 黑名单名单 --------------------------------------------------------------------------------------------------
export const BLACKLIST_FILTER_FIELDS = ['name', 'idNumber', 'mobilePhone', 'reason', 'source'] as const;
export type BlacklistStatus = (typeof BLACKLIST_STATUSES)[number];
export type BlacklistFilter = { status: BlacklistStatus } & Partial<
  Record<(typeof BLACKLIST_FILTER_FIELDS)[number], string>
>;
export const BLACKLIST_PAGE_SIZE = 20;
// 查询串：服务端按不可查看的字段筛选返回 403，所以不可查看的字段不进查询；空白不进查询。
// 筛选条件变化时页码由页面重置为 1（不同筛选的页不混用）。
export function blacklistQuery(filter: BlacklistFilter, page: number, viewable: (field: string) => boolean) {
  const query = new URLSearchParams({ status: filter.status });
  for (const field of BLACKLIST_FILTER_FIELDS) {
    const value = filter[field]?.trim();
    if (value && viewable(field)) query.set(field, value);
  }
  query.set('page', String(page));
  query.set('pageSize', String(BLACKLIST_PAGE_SIZE));
  return `${BLACKLIST_PATH}?${query}`;
}
/** 列表页：无总数，回显的页码与页长须是本次请求的，避免慢请求把别的页 / 筛选的结果显示出来。 */
export function parseBlacklistPage(raw: unknown, page: number) {
  if (!isRecord(raw) || raw.page !== page || raw.pageSize !== BLACKLIST_PAGE_SIZE) throw new Error(s.invalidList);
  if (typeof raw.hasDataPermission !== 'boolean') throw new Error(s.invalidList);
  const items = parseRows(raw, 'blacklist');
  return { items, hasDataPermission: raw.hasDataPermission, hasNext: items.length === BLACKLIST_PAGE_SIZE };
}
/** 移出回执 { items: [行] }：本行、版本 + 1；状态被裁剪时不核对，出现时须为已移出。 */
export function parseRemoveReceipt(raw: unknown, expected: { id: string; revision: number }) {
  const items = isRecord(raw) ? raw.items : undefined;
  const row: unknown = Array.isArray(items) && items.length === 1 ? items[0] : undefined;
  if (!isRow(row, 'blacklist') || row.id !== expected.id || row.revision !== expected.revision + 1)
    throw new Error(s.invalidReceipt);
  if ('status' in row && row.status !== 'removed') throw new Error(s.invalidReceipt);
  return { id: row.id };
}
/** 黑名单删除回执 { deleted: n }：单条删除须为 1。 */
export function parseBlacklistDeleteReceipt(raw: unknown, id: string) {
  if (!isRecord(raw) || raw.deleted !== 1) throw new Error(s.invalidReceipt);
  return { id };
}
/** 批量移出 / 删除的请求体：逐条带版本，不用 If-Match。 */
export const batchBody = (id: string, revision: number) => ({ items: [{ id, revision }] });

export const BLACKLIST_IDENTITIES = ['idNumber', 'mobilePhone', 'email'] as const;
export const BLACKLIST_CREATE_FIELDS = ['name', ...BLACKLIST_IDENTITIES, 'reason', 'expiryDate', 'note'] as const;
export const BLACKLIST_UPDATE_FIELDS = ['reason', 'expiryDate', 'note'] as const;
/** 手工加黑须填姓名，证件号码 / 手机号 / 邮箱至少一项（后端 createInput）：本地先拦，不进内核。 */
export const hasIdentity = (values: Values) =>
  BLACKLIST_IDENTITIES.some((field) => typeof values[field] === 'string' && values[field].trim() !== '');

// 黑名单写能力：数据操作 + 列表按钮（新增 / 移出 / 删除为 list，编辑为 list_row）+ 字段编辑权。
// 新增须姓名、原因可编辑且至少一种联系标识可编辑；编辑按字段逐项给。明细未懒加载（summary）时都不给。
// 黑名单没有组织字段，数据范围只认看全部：列表回 hasDataPermission=false（如人事专员）时服务端拒绝写入，这里也不给。
export function blacklistAccess(permission: ObjectPermission | undefined, hasDataPermission: boolean) {
  const detail = permission && !permission.summary ? permission : undefined;
  const loaded = hasDataPermission ? detail : undefined;
  // 可查看只看字段权限（筛选项据此给出，不随列表结果变化，避免查询串与结果互相牵动）；写能力再叠加数据范围。
  const viewable = (field: string) => !!detail?.viewableFields.includes(field);
  const editable = (field: string) => viewable(field) && !!loaded?.editableFields.includes(field);
  const allowed = (operation: string, button: string, level: string) =>
    loaded?.dataOperations[operation] === true && canButton(loaded, button, level);
  const createFields = allowed('create', 'create', 'list') ? BLACKLIST_CREATE_FIELDS.filter(editable) : [];
  const create =
    createFields.includes('name') &&
    createFields.includes('reason') &&
    BLACKLIST_IDENTITIES.some((field) => createFields.includes(field));
  return {
    viewable,
    create,
    createFields: create ? createFields : [],
    updateFields: allowed('update', 'update', 'list_row') ? BLACKLIST_UPDATE_FIELDS.filter(editable) : [],
    remove: allowed('update', 'remove', 'list'),
    delete: allowed('delete', 'delete', 'list'),
  };
}
export type BlacklistAccess = ReturnType<typeof blacklistAccess>;

// ---- 配置类（交接事项、规则、两项租户设置）的写能力 -------------------------------------------------------------
/** 租户设置与任职设置配置写入的准入都是管理员能力 other_settings；前端唯一对应信号是“管理单元设置”菜单可编辑。 */
export function otherSettingsEditable(menus: readonly MenuNode[]) {
  const settings = menus.find((menu) => menu.key === 'settings')?.children ?? [];
  return settings.find((menu) => menu.key === 'other.mou_settings')?.editable === true;
}
// 交接事项 / 规则是整份保存（严格 DTO，后端按载荷全部字段核对编辑权）：全部字段可看可改、且持有 other_settings 才开放；
// 新增看 create，修改与删除看 update（配置对象没有删除数据操作，后端删除按 update 判断）。
export function configAccess(
  permission: ObjectPermission | undefined,
  menus: readonly MenuNode[],
  fields: readonly string[],
) {
  const loaded = permission && !permission.summary ? permission : undefined;
  const all =
    !!loaded &&
    otherSettingsEditable(menus) &&
    fields.every((field) => loaded.viewableFields.includes(field) && loaded.editableFields.includes(field));
  return { create: all && loaded.dataOperations.create === true, update: all && loaded.dataOperations.update === true };
}
export type ConfigAccess = ReturnType<typeof configAccess>;

/** 交接事项整份保存的请求体：未改项取最新全量，空白的可选文本按后端口径提交 null。 */
export function itemBody(full: Values, edited: Values) {
  const merged = { ...full, ...edited };
  return {
    category: String(merged.category ?? '').trim(),
    sequenceNo: merged.sequenceNo,
    todoType: merged.todoType,
    title: String(merged.title ?? '').trim(),
    formRef: blankToNull(merged.formRef),
    remark: blankToNull(merged.remark),
  };
}
function blankToNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
/** 按事项类别分组（保持服务端的序号顺序；类别被裁剪的行归入占位组）。 */
export function groupByCategory(rows: readonly Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = typeof row.category === 'string' ? row.category : s.placeholder;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([category, items]) => ({ category, items }));
}

/** 规则表单把条件展开成“离职次数 ≥ N”一项（后端只接受这一种条件）。 */
export function ruleValues(row: Row): Values {
  const conditions = Array.isArray(row.conditions) ? (row.conditions as { value: number }[]) : [];
  return { ...row, exitCount: conditions[0]?.value };
}
/** 规则整份保存：没改离职次数就原样带回条件（含多条），改了就按一条“离职次数 ≥ N”提交。 */
export function ruleBody(full: Values, edited: Values) {
  const merged = { ...full, ...edited };
  return {
    name: String(merged.name ?? '').trim(),
    priority: merged.priority,
    orgIds: merged.orgIds,
    description: blankToNull(merged.description),
    conditions:
      'exitCount' in edited
        ? [{ field: 'exitCount', operator: 'gte', value: edited.exitCount }]
        : (merged.conditions ?? [{ field: 'exitCount', operator: 'gte', value: merged.exitCount }]),
    term: merged.term,
    reason: merged.reason,
    note: blankToNull(merged.note),
  };
}

// ---- 租户设置（交接发起规则、自动加黑总开关）----------------------------------------------------------------------
export type Setting<T> = { value: T; revision: number; source: 'system' | 'tenant'; overridable: boolean };
function parseSettingWith<T>(raw: unknown, key: string, valid: (value: unknown) => value is T): Setting<T> {
  if (!isRecord(raw) || raw.key !== key || !valid(raw.value)) throw new Error(s.invalidRead);
  const { revision, source, overridable } = raw;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0 || typeof overridable !== 'boolean')
    throw new Error(s.invalidRead);
  if (source !== 'system' && source !== 'tenant') throw new Error(s.invalidRead);
  return { value: raw.value, revision: revision as number, source, overridable };
}
const isTrigger = (value: unknown): value is HandoverTriggerSetting => checkHandoverTrigger(value).ok;
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
export const parseTrigger = (raw: unknown) => parseSettingWith(raw, EXIT_HANDOVER_TRIGGER_KEY, isTrigger);
export const parseAutoBlacklist = (raw: unknown) => parseSettingWith(raw, AUTO_BLACKLIST_SETTING_KEY, isBoolean);
/** PUT 回执是有效设置：本键、取值合法、版本 = 实际提交的版本（If-Match）+ 1。 */
export function parseSettingReceipt(raw: unknown, key: string, revision: number) {
  const valid = key === AUTO_BLACKLIST_SETTING_KEY ? isBoolean : isTrigger;
  const setting = parseSettingWith(raw, key, valid as (value: unknown) => value is unknown);
  if (setting.revision !== revision + 1 || setting.source !== 'tenant') throw new Error(s.invalidReceipt);
  return { id: key };
}

/** 发起规则表单字段（提醒拆成三个平铺字段），与 triggerValues 的键一致。 */
export const TRIGGER_FIELDS = Object.keys(triggerValues(HANDOVER_TRIGGER_DEFAULT));
export function triggerValues(value: HandoverTriggerSetting): Values {
  return {
    enabled: value.enabled,
    method: value.method,
    daysBeforeLastWorkDate: value.daysBeforeLastWorkDate ?? null,
    nodeKey: value.nodeKey ?? null,
    includePastLastWorkDate: value.includePastLastWorkDate,
    remindEnabled: value.remind.enabled,
    remindBefore: value.remind.daysBeforeLastWorkDate,
    remindAfter: value.remind.daysAfterLastWorkDate,
  };
}
// 发起规则整份替换（结构严格，不接受未知键）：未改项取最新全量；提前天数只在“最后工作日前若干天”、节点标识只在
// “指定节点同意后”提交，不把隐藏的旧值带回去。发起人只接受员工本人（F-250 / DEC-683）。
export function triggerBody(full: Values, edited: Values): HandoverTriggerSetting {
  const merged = { ...full, ...edited };
  const method = merged.method as HandoverTriggerSetting['method'];
  const nodeKey = typeof merged.nodeKey === 'string' ? merged.nodeKey.trim() : '';
  return {
    enabled: merged.enabled === true,
    method,
    ...(method === 'days_before_last_work_date'
      ? { daysBeforeLastWorkDate: merged.daysBeforeLastWorkDate as number }
      : {}),
    ...(method === 'on_node_approved' ? { nodeKey } : {}),
    includePastLastWorkDate: merged.includePastLastWorkDate === true,
    initiator: HANDOVER_VERIFIED_INITIATOR,
    remind: {
      enabled: merged.remindEnabled === true,
      daysBeforeLastWorkDate: merged.remindBefore as number,
      daysAfterLastWorkDate: merged.remindAfter as number,
    },
  };
}
