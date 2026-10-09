/**
 * 权限模块路由的现状声明（F-039 PR-A；附录 A「/api/tenant/permission」43 条：routes 17 / data-scope 8 /
 * scope-policy 12 / user-routes 6）。企业设置类接口按 8 类管理员能力鉴权（06 §7.1），权限配置 DTO 没有字段目录，
 * 按能力整对象可见；写入口事务内是 adminCommand 的权限审计（permission_*），配置对象无范围故返回后不复核。
 * 与附录 A 的差异（按现状代码修正）：PUT / DELETE person-links 的处理函数是固定拒绝（不查管理员能力），
 * 登记为 member + 守卫 permission.personLinksReadOnly，而非 admin other_settings。
 */
import { defineTable, type RoutePolicy } from '../../route-policy/index.js';
import {
  admin,
  commandWrite,
  configWrite,
  fixed,
  member,
  noFields,
  none,
  NOT_FOUND,
  write,
} from '../../route-policy/presets.js';

const BASE = '/api/tenant/permission';
/** `permission/http.idParam`：路径标识非法 → 404 NOT_FOUND。 */
const byId = { invalidId: NOT_FOUND };
const adminCommand = configWrite('permission.adminCommand');
const otherSettings = admin('other_settings');
const otherSettingsById = admin('other_settings', byId);
const otherSettingsWrite = admin('other_settings', { write: adminCommand });
const otherSettingsWriteById = admin('other_settings', { ...byId, write: adminCommand });
/** DEC-128：用户与人员的绑定随人员档案产生；手工绑定 / 改绑 / 解绑的入口对任何成员都固定 403。 */
const personLinkReadOnly: RoutePolicy = member(
  '处理函数固定拒绝（403 FORBIDDEN / USER_BINDING_BY_PROFILE），不查管理员能力',
  noFields('固定拒绝，无响应体字段'),
  {
    guards: ['permission.personLinksReadOnly'],
    write: write(none('固定拒绝，不读请求体'), none('固定拒绝，不进台账'), none('固定拒绝，无返回对象')),
  },
);
const platformUserWrite = (reason: string) =>
  write(none(reason), 'permission.platformUser', none('成员关系无范围，返回后只投影'));

export const PERMISSION_POLICIES = defineTable('permission', {
  // ---- data-scope-routes.ts / scope-policy-routes.ts：数据权限设置（other_settings）------------------------------
  [`GET ${BASE}/profiles/:id/data-scopes/:appCode`]: otherSettingsById,
  [`PUT ${BASE}/profiles/:id/data-scopes/:appCode`]: otherSettingsWriteById,
  [`GET ${BASE}/scope-apps/:appCode`]: otherSettings,
  [`PUT ${BASE}/scope-apps/:appCode`]: otherSettingsWrite,
  [`GET ${BASE}/person-links/:userId`]: otherSettingsById,
  [`PUT ${BASE}/person-links/:userId`]: personLinkReadOnly,
  [`DELETE ${BASE}/person-links/:userId`]: personLinkReadOnly,
  [`GET ${BASE}/dynamic-org-grants/:grantId`]: otherSettingsById,
  [`PUT ${BASE}/dynamic-org-grants/:grantId`]: otherSettingsWriteById,
  [`DELETE ${BASE}/dynamic-org-grants/:grantId`]: otherSettingsWriteById,
  [`GET ${BASE}/scope-policies/:appCode/:objectCode/:targetKind/:targetCode`]: otherSettings,
  [`PUT ${BASE}/scope-policies/:appCode/:objectCode/:targetKind/:targetCode`]: otherSettingsWrite,
  [`GET ${BASE}/mous`]: admin('mou_manage'),
  [`GET ${BASE}/mous/:id`]: admin('mou_manage', byId),
  [`POST ${BASE}/mous`]: otherSettingsWrite,
  [`PUT ${BASE}/mous/:id`]: otherSettingsWriteById,
  [`DELETE ${BASE}/mous/:id`]: otherSettingsWriteById,
  [`GET ${BASE}/scopes/:userId/:appCode`]: otherSettingsById,
  [`PUT ${BASE}/scopes/:userId/:appCode`]: otherSettingsWriteById,
  [`GET ${BASE}/grant-prefill/:userId/:profileId`]: otherSettingsById,
  // ---- user-routes.ts：用户管理（user_manage；停用 / 移出走平台流程，platformCommandId 平台台账 + 租户审计）----
  [`GET ${BASE}/users`]: admin('user_manage'),
  [`GET ${BASE}/users/:userId`]: admin('user_manage', byId),
  [`POST ${BASE}/users`]: admin('user_manage', { write: platformUserWrite('外部用户登记 DTO，无字段目录') }),
  [`PUT ${BASE}/users/:userId`]: admin('user_manage', { ...byId, write: adminCommand }),
  [`POST ${BASE}/users/:userId/status`]: admin('user_manage', { ...byId, write: platformUserWrite('status 开关') }),
  [`POST ${BASE}/users/:userId/remove`]: admin('user_manage', {
    ...byId,
    write: commandWrite('permission.platformUser', none('成员关系无范围')),
  }),
  // ---- routes.ts：身份 / 用户授权 / 管理员 / 许可 / 菜单 / 本人 ---------------------------------------------------
  [`GET ${BASE}/profiles`]: admin('profile_manage'),
  [`GET ${BASE}/profiles/:id`]: admin('profile_manage', byId),
  [`POST ${BASE}/profiles`]: admin('profile_manage', { write: adminCommand }),
  [`PUT ${BASE}/profiles/:id/objects/:objectCode`]: admin('profile_manage', {
    ...byId,
    write: write(none('整对象替换的权限 DTO（512KB 上限）'), 'permission.adminCommand', none('配置对象无范围')),
  }),
  [`GET ${BASE}/grantable-profiles`]: admin('user_grant'),
  [`GET ${BASE}/grants`]: admin('user_grant'),
  // body.scopes 非空须另有 other_settings（附加守卫）
  [`POST ${BASE}/grants`]: admin('user_grant', {
    guards: ['permission.grantScopesRequireOtherSettings'],
    write: adminCommand,
  }),
  // 撤销身份不删范围（硬规则 6）
  [`POST ${BASE}/grants/:id/revoke`]: admin('user_grant', {
    ...byId,
    write: commandWrite('permission.adminCommand', none('配置对象无范围')),
  }),
  [`GET ${BASE}/admins`]: admin('admin_manage'),
  [`GET ${BASE}/admins/:id`]: admin('admin_manage', byId),
  [`POST ${BASE}/admins`]: admin('admin_manage', { write: adminCommand }),
  [`PUT ${BASE}/admins/:id`]: admin('admin_manage', { ...byId, write: adminCommand }),
  [`GET ${BASE}/licenses`]: admin('license_balance', { fields: noFields('许可余额，无字段目录') }),
  [`GET ${BASE}/licenses/:licenseType/seats`]: admin('license_usage', { fields: noFields('使用明细，无字段目录') }),
  [`GET ${BASE}/admin-roles`]: admin('admin_manage', { fields: noFields('固定字典') }),
  // 本人可见的企业设置菜单（06 §7.1）；普通成员得到空列表
  [`GET ${BASE}/admin-menus`]: member(
    '本人可见菜单，普通成员空列表',
    fixed(['code', 'path', 'implemented', 'editable'], '06 §7.1 visibleEnterpriseMenus'),
  ),
  // 本人对某对象的有效功能权限；objectCode 非法 → 404
  [`GET ${BASE}/me/objects/:objectCode`]: member('本人对某对象的有效权限', noFields('权限结构，不是业务字段'), byId),
});
