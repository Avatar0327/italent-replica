/**
 * 租户两层配置路由的现状声明（F-039 PR-A；附录 A「/api/tenant/settings」3 条）。
 * 现状经 requirePermission('tenant.settings.read' / 'tenant.settings.write', resource = key)，授权器映射到
 * 管理员能力 other_settings；配置值没有字段目录；写入口事务内只有配置审计（tenant_setting_override）。
 */
import { defineTable } from '../../route-policy/index.js';
import { admin, noFields, none, write } from '../../route-policy/presets.js';

const settingFields = noFields('配置值没有字段目录');
const settingWrite = write(
  none('配置值，无字段目录'),
  'config.audited:tenant_setting_override',
  none('配置对象无范围'),
);

export const TENANT_SETTING_POLICIES = defineTable('tenant-settings', {
  'GET /api/tenant/settings/:key': admin('other_settings', { alias: 'tenant.settings.read', fields: settingFields }),
  'PUT /api/tenant/settings/:key': admin('other_settings', {
    alias: 'tenant.settings.write',
    fields: settingFields,
    write: settingWrite,
  }),
  'DELETE /api/tenant/settings/:key/override': admin('other_settings', {
    alias: 'tenant.settings.write',
    fields: settingFields,
    write: settingWrite,
  }),
});
