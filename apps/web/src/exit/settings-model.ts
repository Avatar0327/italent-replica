// FE-R2c2b 离职设置页纯规则：桩（签名与实现一致、返回错值），仅供失败测试提交使用，实现提交整份替换。
import type { BLACKLIST_STATUSES } from '@italent/domain';
import {
  AUTO_BLACKLIST_SETTING_KEY,
  EXIT_HANDOVER_TRIGGER_KEY,
  HANDOVER_TRIGGER_DEFAULT,
  type HandoverTriggerSetting,
} from '@italent/domain';
import type { Values } from '../foundation/forms/store.js';
import type { MenuNode } from '../foundation/permission-snapshot.js';
import type { ObjectPermission } from '../foundation/permission-model.js';

export const SETTINGS_TABS = ['handover-items', 'handover-trigger', 'blacklist', 'blacklist-rules'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const isSettingsTab = (_value: string | undefined): _value is SettingsTab => false;

const EMPLOYMENT = '/api/tenant/employment';
export const HANDOVER_ITEMS_PATH = `${EMPLOYMENT}/exit-handover-items`;
export const BLACKLIST_PATH = `${EMPLOYMENT}/blacklist`;
export const BLACKLIST_RULES_PATH = `${EMPLOYMENT}/blacklist-rules`;
export const settingPath = (key: string) => `/api/tenant/settings/${key}`;
export const TRIGGER_PATH = settingPath(EXIT_HANDOVER_TRIGGER_KEY);
export const AUTO_BLACKLIST_PATH = settingPath(AUTO_BLACKLIST_SETTING_KEY);
export const BLACKLIST_OBJECT = 'TenantBase.Blacklist';
export const rowPath = (collection: string, id: string) => `${collection}/${encodeURIComponent(id)}`;

export type Row = Values & { id: string; revision: number };
export type Shape = 'item' | 'rule' | 'blacklist';
export const HANDOVER_ITEM_FIELDS: string[] = [];
export const RULE_FIELDS: string[] = [];
export const parseRows = (_raw: unknown, _shape: Shape): Row[] => [];
export const parseRowReceipt = (_raw: unknown, _shape: Shape, expected: { id?: string; revision: number }) => ({
  id: expected.id ?? '',
});
export const parseDeleteReceipt = (_raw: unknown, id: string) => ({ id });

export const BLACKLIST_FILTER_FIELDS = ['name', 'idNumber', 'mobilePhone', 'reason', 'source'] as const;
export type BlacklistStatus = (typeof BLACKLIST_STATUSES)[number];
export type BlacklistFilter = { status: BlacklistStatus } & Partial<
  Record<(typeof BLACKLIST_FILTER_FIELDS)[number], string>
>;
export const BLACKLIST_PAGE_SIZE = 20;
export const blacklistQuery = (_filter: BlacklistFilter, _page: number, _viewable: (field: string) => boolean) =>
  BLACKLIST_PATH;
export const parseBlacklistPage = (_raw: unknown, _page: number) => ({
  items: [] as Row[],
  hasDataPermission: false,
  hasNext: false,
});
export const parseRemoveReceipt = (_raw: unknown, expected: { id: string; revision: number }) => ({ id: expected.id });
export const parseBlacklistDeleteReceipt = (_raw: unknown, id: string) => ({ id });
export const batchBody = (_id: string, _revision: number) => ({ items: [] as { id: string; revision: number }[] });

export const BLACKLIST_IDENTITIES = ['idNumber', 'mobilePhone', 'email'] as const;
export const BLACKLIST_CREATE_FIELDS = ['name', ...BLACKLIST_IDENTITIES, 'reason', 'expiryDate', 'note'] as const;
export const BLACKLIST_UPDATE_FIELDS = ['reason', 'expiryDate', 'note'] as const;
export const hasIdentity = (_values: Values) => true;
export function blacklistAccess(_permission: ObjectPermission | undefined, _hasDataPermission: boolean) {
  return {
    viewable: (_field: string) => false,
    create: false,
    createFields: [] as string[],
    updateFields: [] as string[],
    remove: false,
    delete: false,
  };
}
export type BlacklistAccess = ReturnType<typeof blacklistAccess>;

export const otherSettingsEditable = (_menus: readonly MenuNode[]) => false;
export const configAccess = (
  _permission: ObjectPermission | undefined,
  _menus: readonly MenuNode[],
  _fields: readonly string[],
) => ({ create: false, update: false });
export type ConfigAccess = ReturnType<typeof configAccess>;
export const itemBody = (_full: Values, _edited: Values): Values => ({});
export const groupByCategory = (_rows: readonly Row[]): { category: string; items: Row[] }[] => [];
export const ruleValues = (_row: Row): Values => ({});
export const ruleBody = (_full: Values, _edited: Values): Values => ({});

export type Setting<T> = { value: T; revision: number; source: 'system' | 'tenant'; overridable: boolean };
const stubSetting = <T>(value: T): Setting<T> => ({ value, revision: 0, source: 'system', overridable: true });
export const parseTrigger = (_raw: unknown) => stubSetting(HANDOVER_TRIGGER_DEFAULT);
export const parseAutoBlacklist = (_raw: unknown) => stubSetting(false);
export const parseSettingReceipt = (_raw: unknown, key: string, _revision: number) => ({ id: key });
export const TRIGGER_FIELDS: string[] = [];
export const triggerValues = (_value: HandoverTriggerSetting): Values => ({});
export const triggerBody = (_full: Values, _edited: Values): HandoverTriggerSetting => HANDOVER_TRIGGER_DEFAULT;
