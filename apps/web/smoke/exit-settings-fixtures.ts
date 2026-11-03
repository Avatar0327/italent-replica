// FE-R2c2b 离职设置页（交接事项 / 交接发起规则 / 黑名单 / 自动加黑规则）的冒烟夹具：形态照抄真实接口
// （exit-handover-items.ts、blacklist.ts、blacklist-rules.ts、tenant-settings/service.ts），由
// tests/acceptance/AC-FE-R2c2b-exit-settings.test.ts 用真实接口逐键核对。本文件不引用 playwright，数据全部为合成值。
import { HANDOVER_TRIGGER_DEFAULT } from '@italent/domain';

/** GET /exit-handover-items 的行：业务字段 + id / revision（按字段裁剪，被裁剪的键直接缺失）。 */
export const handoverItem = {
  id: '61000000-0000-4000-8000-000000000001',
  category: '行政',
  sequenceNo: 1,
  todoType: 'work_handover',
  title: '归还门禁卡',
  formRef: null as string | null,
  remark: null as string | null,
  revision: 1,
};
export type HandoverItemRow = typeof handoverItem;

/** GET /blacklist-rules 的行。 */
export const blacklistRule = {
  id: '62000000-0000-4000-8000-000000000001',
  name: '离职三次永久',
  priority: 1,
  orgIds: ['63000000-0000-4000-8000-000000000001'],
  description: null as string | null,
  conditions: [{ field: 'exitCount', operator: 'gte', value: 3 }],
  term: 'permanent',
  reason: 'instability',
  note: null as string | null,
  revision: 1,
};
export type BlacklistRuleRow = typeof blacklistRule;

/** GET /blacklist 的行（列表与新增 / 编辑 / 移出回执同形）。 */
export const blacklistEntry = {
  id: '64000000-0000-4000-8000-000000000001',
  employeeId: null as string | null,
  name: '外部人员甲',
  idNumber: null as string | null,
  mobilePhone: '13800000001' as string | null,
  email: null as string | null,
  reason: 'other',
  blacklistDate: '2026-10-01',
  expiryDate: null as string | null,
  note: null as string | null,
  source: 'manual',
  status: 'active',
  removedAt: null as string | null,
  revision: 1,
};
export type BlacklistEntryRow = typeof blacklistEntry;

/** 黑名单列表页：没有总数；下一页按“本页满页”判断。 */
export const blacklistPage = (items: BlacklistEntryRow[], page: number, pageSize: number) => ({
  items,
  page,
  pageSize,
  hasDataPermission: true,
});

/** 租户管理员（标准版系统管理员）读黑名单对象：全部数据操作与四个按钮，系统字段只可查看。 */
const blacklistFields = ['email', 'employeeId', 'expiryDate', 'idNumber', 'mobilePhone', 'name', 'note', 'reason'];
const blacklistSystem = [
  'blacklistDate',
  'createdAt',
  'createdBy',
  'id',
  'previousVersionId',
  'removedAt',
  'revision',
  'source',
  'status',
  'tenantId',
  'updatedAt',
  'versionId',
  'versionNo',
];
export const blacklistPermission = {
  objectCode: 'TenantBase.Blacklist',
  dataOperations: { create: true, update: true, delete: true },
  viewableFields: [...blacklistFields, ...blacklistSystem].sort(),
  editableFields: [...blacklistFields].sort(),
  buttons: [
    { buttonCode: 'create', level: 'list' },
    { buttonCode: 'delete', level: 'list' },
    { buttonCode: 'remove', level: 'list' },
    { buttonCode: 'update', level: 'list_row' },
  ],
};

/** GET /api/tenant/settings/exit.handover_trigger 未覆盖时（系统值）。 */
export const triggerDefault = {
  key: 'exit.handover_trigger',
  value: HANDOVER_TRIGGER_DEFAULT as unknown,
  source: 'system' as 'system' | 'tenant',
  revision: 0,
  systemVersion: 1,
  overridable: true,
};
/** GET /api/tenant/settings/exit.auto_blacklist_enabled 未覆盖时（系统值关闭）。 */
export const autoBlacklistDefault = {
  key: 'exit.auto_blacklist_enabled',
  value: false as unknown,
  source: 'system' as 'system' | 'tenant',
  revision: 0,
  systemVersion: 1,
  overridable: true,
};

/** 删除回执：交接事项 / 规则 { id, deleted: true }；黑名单批量删除 { deleted: n }。 */
export const deletedReceipt = (id: string) => ({ id, deleted: true });
/** 任职模块的版本冲突（context.ts assertRevision）：交接事项 / 规则 / 黑名单共用。 */
export const revisionConflict = { error: { code: 'REVISION_CONFLICT', message: '任职数据已变更，请刷新后显式重提' } };
/** 已移出的黑名单记录不能编辑（blacklist.ts）。 */
export const blacklistRemoved = { error: { code: 'CONFLICT', message: '黑名单记录已移出' } };
