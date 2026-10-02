/**
 * L2 租户管理层：8 类标准企业管理员身份及其企业设置能力（REQ-PRM-001 层级定义；docs/02_业务建模/06 §7.1，G-008）。
 * 能力矩阵逐行照搬官方《各个企业管理员身份权限对比》（系统管理员列经运行核对 39/39）。
 * 管理员不是一个“超级管理员”，而是按职责切分的固定身份；一个用户可持有多个管理员身份，能力取并集。
 */

export const ADMIN_ROLES = [
  'tenant_admin', // 租户管理员
  'system_admin', // 系统管理员
  'employee_admin', // 员工管理员
  'user_admin', // 用户管理员
  'permission_admin', // 权限管理员
  'matrix_admin', // 矩阵管理员
  'audit_admin', // 审计管理员
  'billing_admin', // 计费管理员
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

/** 能力 → 持有该能力的管理员身份（06 §7.1 表格逐行）。 */
const CAPABILITY_HOLDERS = {
  user_manage: ['tenant_admin', 'system_admin', 'employee_admin', 'user_admin'], // 用户管理
  user_grant: ['tenant_admin', 'system_admin', 'user_admin', 'permission_admin'], // 用户授权
  admin_manage: ['tenant_admin', 'system_admin', 'user_admin', 'permission_admin'], // 管理员
  mou_manage: ['tenant_admin', 'system_admin', 'user_admin', 'permission_admin'], // 管理单元
  implementer_grant: ['tenant_admin'], // 实施人员授权
  dynamic_grant: ['tenant_admin'], // 动态授权
  permission_query: ['tenant_admin', 'audit_admin'], // 权限查询
  profile_manage: ['tenant_admin', 'system_admin'], // 身份管理、菜单组管理
  org_structure: ['tenant_admin', 'system_admin', 'employee_admin'], // 组织架构、数据导入
  enterprise_security: ['tenant_admin'], // 企业安全
  audit_log: ['tenant_admin', 'audit_admin'], // 日志审计
  license_balance: ['tenant_admin', 'system_admin', 'billing_admin'], // 许可：余额
  license_usage: ['tenant_admin', 'billing_admin'], // 许可：使用明细
  process_matrix: ['tenant_admin', 'system_admin', 'matrix_admin'], // 流程矩阵
  portal: ['tenant_admin', 'system_admin'], // 门户
  other_settings: ['tenant_admin'], // 其他设置：数据权限设置、管理单元设置、受信 IP 生效范围
} as const satisfies Record<string, readonly AdminRole[]>;

export type AdminCapability = keyof typeof CAPABILITY_HOLDERS;

export const ADMIN_CAPABILITIES = Object.keys(CAPABILITY_HOLDERS) as AdminCapability[];

export function isAdminCapability(value: string): value is AdminCapability {
  return Object.hasOwn(CAPABILITY_HOLDERS, value);
}

/** 持有的管理员身份中任一具备该能力即可（多身份取并集，REQ-PRM-001 R3）。 */
export function hasAdminCapability(roles: Iterable<AdminRole>, capability: AdminCapability): boolean {
  const holders: readonly AdminRole[] = CAPABILITY_HOLDERS[capability];
  for (const role of roles) if (holders.includes(role)) return true;
  return false;
}
