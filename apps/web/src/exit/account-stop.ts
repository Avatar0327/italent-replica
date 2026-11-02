/**
 * F-327 账号停用时间配置的纯规则（后端 employment/exit-account-store.ts accountSettingBody，F-261 / DEC-684）。
 * 本文件被页面与 vitest 引用，不依赖 React 或浏览器 API；权威校验仍在服务端。
 */
import type { MenuNode } from '../foundation/permission-snapshot.js';
import type { ObjectPermission } from '../foundation/permission-model.js';
import type { Values } from '../foundation/forms/store.js';
import { a } from './account-stop-messages.js';

/** 设置页签的路径段，与三个字典页签同级（/exit-settings/account-stop）。 */
export const ACCOUNT_STOP_TAB = 'account-stop';
/** 单例配置：内核按“集合 + 固定 id”成恢复槽，键为稳定原单路径 ACCOUNT_STOP_PATH。 */
export const ACCOUNT_STOP_RESOURCE = '/api/tenant/employment/exit-account';
export const ACCOUNT_STOP_ID = 'settings';
export const ACCOUNT_STOP_PATH = `${ACCOUNT_STOP_RESOURCE}/${ACCOUNT_STOP_ID}`;
/** PUT 的唯一准入是管理员能力 other_settings（policy.ts）；前端唯一对应信号是“管理单元设置”菜单的可编辑标记。 */
export const OTHER_SETTINGS_MENU = 'other.mou_settings';

export const BASES = ['actual_leave_date', 'last_work_date'] as const;
export type Basis = (typeof BASES)[number];
// 类型别名而非接口：可直接作为内核的 Values 投影。
export type AccountStop = {
  earlyEnabled: boolean;
  basis: Basis | null;
  time: string | null;
  inReview: boolean;
  revision: number;
};
export const ACCOUNT_STOP_FIELDS = ['earlyEnabled', 'basis', 'time', 'inReview'] as const;
/** 与后端同一正则：00:00～23:59。 */
export const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const KEYS = [...ACCOUNT_STOP_FIELDS, 'revision'].sort().join();
const isAccountStop = (raw: unknown): raw is AccountStop => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const row = raw as Partial<AccountStop>;
  return (
    Object.keys(row).sort().join() === KEYS &&
    typeof row.earlyEnabled === 'boolean' &&
    typeof row.inReview === 'boolean' &&
    (row.basis === null || BASES.includes(row.basis as Basis)) &&
    (row.time === null || (typeof row.time === 'string' && TIME_PATTERN.test(row.time))) &&
    (!row.earlyEnabled || (row.basis !== null && row.time !== null)) &&
    Number.isSafeInteger(row.revision) &&
    row.revision! >= 0
  );
};
/** GET 回显：恰好这五个键且取值合法，否则按读取失败处理，不当作默认值。 */
export function parseAccountStop(raw: unknown): AccountStop {
  if (!isAccountStop(raw)) throw new Error(a.invalidRead);
  return raw;
}
/** PUT 回执是整份配置：版本 = 实际提交的版本（If-Match）+ 1，否则按结果未知处理。 */
export function parseAccountStopReceipt(raw: unknown, revision: number) {
  if (!isAccountStop(raw) || raw.revision !== revision + 1) throw new Error(a.invalidReceipt);
  return { id: ACCOUNT_STOP_ID };
}

export const accountStopValues = (row: AccountStop): Values => ({
  earlyEnabled: row.earlyEnabled,
  basis: row.basis,
  time: row.time,
  inReview: row.inReview,
});
/**
 * 后端是整份替换的严格 DTO（四个键都必填），内核按补丁只给出改过的字段：未改项取最新全量。
 * 关闭提前停用时依据与时间按后端口径提交 null，不把隐藏的旧值带回去。
 */
export function accountStopBody(full: Values, edited: Values) {
  const merged = { ...full, ...edited };
  const early = merged.earlyEnabled === true;
  const text = typeof merged.time === 'string' ? merged.time.trim() : '';
  return {
    earlyEnabled: early,
    basis: early && BASES.includes(merged.basis as Basis) ? (merged.basis as Basis) : null,
    time: early && text ? text : null,
    inReview: merged.inReview === true,
  };
}

/**
 * 写能力（fail-closed）：任职设置对象明细已加载且有修改权，并且持有 other_settings（“管理单元设置”菜单可编辑）。
 * 四个字段不在任职设置对象的字段目录里，后端也不按字段编辑权准入，所以不看 editableFields。
 */
export function accountStopWritable(permission: ObjectPermission | undefined, menus: readonly MenuNode[]) {
  const loaded = permission && !permission.summary ? permission : undefined;
  const settings = menus.find((menu) => menu.key === 'settings')?.children ?? [];
  const other = settings.find((menu) => menu.key === OTHER_SETTINGS_MENU);
  return loaded?.dataOperations.update === true && other?.editable === true;
}
