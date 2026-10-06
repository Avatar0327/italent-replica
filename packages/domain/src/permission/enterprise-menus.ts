/**
 * 企业设置菜单 × 8 类企业管理员身份（R1-T15；docs/02_业务建模/06 §7.1，G-008）。
 * holders 逐行照搬官方《各个企业管理员身份权限对比》（导出 docs/01_证据/导出/企业管理员_8类身份菜单矩阵_官方.tsv，67 行）：
 * 决定菜单是否可见。已在复刻系统实现的菜单另登记读 / 写接口所用的管理员能力（admin-roles.ts）：
 * - view：读接口能力，其持有者必须与 holders 完全一致（可见 ⇔ 后端可读，单测守护）；
 * - edit：写接口能力，其持有者必须是 holders 的子集。可以更窄：管理单元的增删改首版只开放给租户管理员
 *   （REQ-PRM-002「配置边界」），系统 / 用户 / 权限管理员可见但只读。
 * 未登记 view 的菜单只保留入口定义（企业安全、日志审计其余子菜单见 OPEN-007 / G-043；余额分配组等待取证），不可操作。
 */
import { type AdminCapability, type AdminRole, hasAdminCapability } from './admin-roles.js';

export interface EnterpriseMenu {
  readonly code: string;
  /** 一级菜单 / 二级菜单；没有二级菜单的只写一级。 */
  readonly path: string;
  readonly holders: readonly AdminRole[];
  readonly view?: AdminCapability;
  readonly edit?: AdminCapability;
}

export interface VisibleEnterpriseMenu {
  readonly code: string;
  readonly path: string;
  /** 复刻系统已实现该菜单的后端接口。 */
  readonly implemented: boolean;
  /** 当前用户可在该菜单下执行写操作。 */
  readonly editable: boolean;
}

const T = 'tenant_admin';
const S = 'system_admin';
const E = 'employee_admin';
const U = 'user_admin';
const P = 'permission_admin';
const M = 'matrix_admin';
const A = 'audit_admin';
const B = 'billing_admin';

type Row = readonly [
  code: string,
  path: string,
  holders: readonly AdminRole[],
  view?: AdminCapability,
  edit?: AdminCapability,
];

const USERS = [T, S, E, U] as const;
const PERMISSION = [T, S, U, P] as const;

const ROWS: readonly Row[] = [
  ['admin_home', '管理后台首页', [T, S, E, U, P]],
  ['users.internal', '用户管理/内部员工', USERS, 'user_manage', 'user_manage'],
  ['users.external', '用户管理/外部用户', USERS, 'user_manage', 'user_manage'],
  ['users.all', '用户管理/全部用户', USERS, 'user_manage', 'user_manage'],
  ['permission.user_grant', '权限管理/用户授权', PERMISSION, 'user_grant', 'user_grant'],
  ['permission.admins', '权限管理/管理员', PERMISSION, 'admin_manage', 'admin_manage'],
  ['permission.mous', '权限管理/管理单元', PERMISSION, 'mou_manage', 'other_settings'],
  ['permission.implementer_grant', '权限管理/实施人员授权', [T]],
  ['permission.dynamic_grant', '权限管理/动态授权', [T]],
  ['permission.query', '权限管理/权限查询', [T, A]],
  ['permission.profiles', '权限管理/身份管理', [T, S], 'profile_manage', 'profile_manage'],
  ['permission.menu_groups', '权限管理/菜单组管理', [T, S]],
  ['org.organizations', '组织架构/组织', [T, S, E]],
  ['org.jobs', '组织架构/职务', [T, S, E]],
  ['org.job_categories', '组织架构/职务类别', [T, S, E]],
  ['data_import', '数据导入', [T, S, E]],
  ['company_info', '企业信息', [T, S]],
  ['security.directory', '企业安全/通讯录设置', [T]],
  ['security.settings', '企业安全/安全设置', [T]],
  ['security.watermark', '企业安全/水印设置', [T]],
  ['security.trusted_ip', '企业安全/受信IP设置', [T]],
  ['security.support', '企业安全/系统支持设置', [T]],
  ['security.agreement', '企业安全/安全协议设置', [T]],
  ['security.agreement_records', '企业安全/协议签署记录', [T]],
  ['security.field_encryption', '企业安全/字段加密设置', [T]],
  ['security.field_masking', '企业安全/字段脱敏设置', [T]],
  ['security.personal_data_purge', '企业安全/人员数据清除', [T]],
  ['audit.login', '日志审计/登录日志', [T, A]],
  // R1-T16：数据变更日志、对象操作日志、失败命令审计的只读查询挂在这里（20 §5 第 5 条）；其余日志审计子菜单原站未取证（G-043）
  ['audit.business', '日志审计/业务操作日志', [T, A], 'audit_log'],
  ['audit.app_config', '日志审计/应用配置日志', [T, A]],
  ['audit.message', '日志审计/消息发送日志', [T, A]],
  ['audit.masked_field_view', '日志审计/脱敏字段查看日志', [T, A]],
  ['license.balance', '许可管理/余额', [T, S, B], 'license_balance'],
  // TODO(需取证 #47)：余额分配组的语义（分组方式、是否约束授权消耗）未取证，暂只保留入口
  ['license.allocation_groups', '许可管理/余额分配组', [T, S]],
  ['license.usage', '许可管理/使用明细', [T, B], 'license_usage'],
  ['license.sms_failures', '许可管理/短信失败记录', [T]],
  ['matrix.manage', '流程矩阵/矩阵管理', [T, S, M]],
  ['matrix.settings', '流程矩阵/矩阵设置', [T, S, M]],
  ['locale', '语言与时区', [T]],
  ['portal.company_info', '门户设置/企业信息', [T]],
  ['portal.domain', '门户设置/域名设置', [T, S]],
  ['portal.login', '门户设置/登录设置', [T, S]],
  ['portal.third_party', '门户设置/第三方设置', [T]],
  ['portal.theme', '门户设置/系统换肤', [T]],
  ['portal.pc_pages', '门户设置/PC页面管理', [T, S]],
  ['org_unit.full_name', '组织单元设置/组织全称显示设置', [T]],
  ['employee.personal_settings', '员工功能设置/个人设置管理', [T]],
  ['employee.homepage', '员工功能设置/个人主页设置', [T]],
  ['employee.workbench', '员工功能设置/iTalent工作台设置', [T]],
  ['employee.top_menu', '员工功能设置/iTalent顶部菜单组设置', [T]],
  ['sms.signature', '短信设置/短信签名设置', [T]],
  ['mobile.app_menus', '移动端设置/APP菜单设置', [T]],
  ['mobile.app_pages', '移动端设置/APP页面设置', [T]],
  ['mobile.app_general', '移动端设置/APP通用设置', [T]],
  ['mobile.check_in', '移动端设置/签到设置', [T]],
  ['log_permission.data_change', '日志权限设置/数据变更日志权限', [T]],
  ['other.system', '其他设置/系统设置', USERS],
  ['other.data_permission', '其他设置/数据权限设置', [T]],
  ['other.calendar', '其他设置/企业日程设置', [T, S]],
  ['other.talent_compare', '其他设置/人才对比设置', [T]],
  ['other.competency', '其他设置/胜任力', USERS],
  ['other.tasks', '其他设置/任务设置', [T]],
  ['other.mail', '其他设置/邮件服务设置', [T]],
  // 管理单元设置：应用范围类型、身份数据权限、消费策略等配置接口（R1-T02），只给租户管理员
  ['other.mou_settings', '其他设置/管理单元设置', [T], 'other_settings', 'other_settings'],
  ['other.trusted_ip_scope', '其他设置/受信IP生效范围设置', [T]],
  ['currency.settings', '币种与汇率/币种设置', [T]],
  ['currency.rates', '币种与汇率/汇率表', [T]],
];

export const ENTERPRISE_MENUS: readonly EnterpriseMenu[] = ROWS.map(([code, path, holders, view, edit]) => ({
  code,
  path,
  holders,
  ...(view ? { view } : {}),
  ...(edit ? { edit } : {}),
}));

/** 当前用户可见的企业设置菜单：持有的管理员身份中任一在矩阵中打勾即可见（多身份取并集，REQ-PRM-001 R3）。 */
export function visibleEnterpriseMenus(roles: readonly AdminRole[]): VisibleEnterpriseMenu[] {
  return ENTERPRISE_MENUS.filter((menu) => menu.holders.some((role) => roles.includes(role))).map((menu) => ({
    code: menu.code,
    path: menu.path,
    implemented: menu.view !== undefined,
    editable: menu.edit !== undefined && hasAdminCapability(roles, menu.edit),
  }));
}
