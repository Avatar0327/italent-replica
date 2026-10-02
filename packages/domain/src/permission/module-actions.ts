/**
 * 已上线业务模块的路由动作 → 身份对象权限的登记表（R1-T01 接入 R1-T03/T04/T05）。
 * 各模块路由目前按模块粒度鉴权（`tenant.<模块>.read|write`），这里把它们映射到原站对象，
 * 使持有“含该对象、且登记了对象所属应用”的身份的用户可访问；没有身份一律拒绝（fail-closed 不变）。
 * 对象编码取自原站组织员工应用对象注册表（docs/01_证据/导出/组织员工应用_对象注册表_214.txt）。
 *
 * 粒度说明（需在后续任务细化，不在本表里猜）：
 * - 读 = 对象在身份对象清单中；写 = 该对象的「编辑」数据操作开启。模块路由尚未按 新增 / 编辑 / 删除 拆分动作，
 *   也未传入要写的字段，故字段级与按钮级判定要等模块改用 object.create|update|delete（带 fields）后才生效。
 * - 只判定功能权限；记录是否在数据范围内由 R1-T02 判定（DEC-043），resource（如员工 ID）这里不使用。
 * - 字段、按钮元数据由各模块登记；此处先登记空字段 / 按钮的占位定义，只承载应用归属。
 */
import type { DataOperation, ObjectDefinition } from './object-permission.js';

/** 组织员工应用（docs/02_业务建模/06 §1.2「组织员工」；对象注册表的 TenantBase 前缀）。 */
export const ORG_EMPLOYEE_APP = 'TenantBase';

const placeholder = (code: string): ObjectDefinition => ({
  code,
  application: ORG_EMPLOYEE_APP,
  fields: [],
  buttons: [],
});

export const MODULE_OBJECTS = {
  organization: placeholder('TenantBase.Organization'), // 组织单元（R1-T03）
  // TODO(R1-T04 细化)：tenant.job.* 一个动作覆盖职层 / 职等 / 职级 / 序列 / 职务 / 职位等多个原站对象，暂统一按「职务」判定
  jobPost: placeholder('TenantBase.JobPost'),
  establishment: placeholder('TenantBase.OrganizationEstablishment'), // 编制（R1-T04）
  employmentRecord: placeholder('TenantBase.EmploymentRecord'), // 任职记录（R1-T05）
} as const satisfies Record<string, ObjectDefinition>;

export type ModuleAction =
  | { readonly kind: 'object'; readonly objectCode: string; readonly operation: 'view' | DataOperation }
  | { readonly kind: 'admin'; readonly capability: string };

const read = (o: ObjectDefinition): ModuleAction => ({ kind: 'object', objectCode: o.code, operation: 'view' });
const write = (o: ObjectDefinition): ModuleAction => ({ kind: 'object', objectCode: o.code, operation: 'update' });
/**
 * 租户 / 应用配置类接口：原站“其他设置”只有租户管理员可见（06 §7.1），按最严收口。
 * TODO(需取证 #7)：各配置项分属哪类管理员，规格未逐项写明。
 */
const tenantConfiguration: ModuleAction = { kind: 'admin', capability: 'other_settings' };

export const MODULE_ACTIONS: Readonly<Record<string, ModuleAction>> = {
  'tenant.settings.read': tenantConfiguration,
  'tenant.settings.write': tenantConfiguration,
  'tenant.org.read': read(MODULE_OBJECTS.organization),
  'tenant.org.write': write(MODULE_OBJECTS.organization),
  'tenant.job.read': read(MODULE_OBJECTS.jobPost),
  'tenant.job.write': write(MODULE_OBJECTS.jobPost),
  'tenant.establishment.read': read(MODULE_OBJECTS.establishment),
  'tenant.establishment.write': write(MODULE_OBJECTS.establishment),
  'tenant.employment.read': read(MODULE_OBJECTS.employmentRecord),
  'tenant.employment.write': write(MODULE_OBJECTS.employmentRecord),
  // 任职的应用配置（是否允许直接调动、自定义字段及其继承）：同租户配置，按最严收口（需取证 #7）
  'tenant.employment.configuration.write': tenantConfiguration,
};
