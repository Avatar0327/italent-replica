/**
 * 功能权限判定（R1-T01）：把授权钩子的 action / resource 映射为管理员能力或对象权限，默认拒绝（fail-closed）。
 * action 语法：
 *   admin.<能力>                            L2 企业设置能力（admin-roles.ts）
 *   object.view|create|update|delete       resource = 对象编码；view = 对象在任一身份的对象清单中
 *   object.button                          resource = `<对象编码>#<按钮编码>@<级别>`
 * 未知 action、格式不对的 resource 一律拒绝。只判定功能权限；数据范围由 R1-T02 判定（DEC-043）。
 */
import { type AdminRole, hasAdminCapability, isAdminCapability } from './admin-roles.js';
import { executableButtons, mergeObjectPermissions } from './effective.js';
import { BUTTON_LEVELS, type ObjectCatalog, type ObjectPermission } from './object-permission.js';

export interface PermissionSubject {
  readonly adminRoles: readonly AdminRole[];
  /** 用户全部有效授权所对应身份的对象权限（未合并）。 */
  readonly objectPermissions: readonly ObjectPermission[];
}

export interface PermissionQuery {
  readonly action: string;
  readonly resource?: string | undefined;
}

/**
 * R1-T00 已有的租户配置动作。原站“其他设置”只有租户管理员可见（06 §7.1），配置接口按此收口。
 * TODO(需取证 #7)：各租户配置项分属哪类管理员，规格未逐项写明，暂按最严的租户管理员。
 */
const LEGACY_ACTIONS: Readonly<Record<string, string>> = {
  'tenant.settings.read': 'admin.other_settings',
  'tenant.settings.write': 'admin.other_settings',
};

export function decide(subject: PermissionSubject, query: PermissionQuery, catalog: ObjectCatalog): boolean {
  const action = LEGACY_ACTIONS[query.action] ?? query.action;
  if (action.startsWith('admin.')) {
    const capability = action.slice('admin.'.length);
    return isAdminCapability(capability) && hasAdminCapability(subject.adminRoles, capability);
  }
  if (action === 'object.button') return decideButton(subject, query.resource, catalog);
  const op = OBJECT_ACTIONS[action];
  if (op === undefined || !query.resource) return false;
  const effective = mergeObjectPermissions(query.resource, subject.objectPermissions);
  if (!effective) return false;
  return op === 'view' || effective.dataOperations[op];
}

const OBJECT_ACTIONS: Readonly<Record<string, 'view' | 'create' | 'update' | 'delete'>> = {
  'object.view': 'view',
  'object.create': 'create',
  'object.update': 'update',
  'object.delete': 'delete',
};

const BUTTON_RESOURCE = new RegExp(`^([^#]+)#([^@]+)@(${BUTTON_LEVELS.join('|')})$`);

function decideButton(subject: PermissionSubject, resource: string | undefined, catalog: ObjectCatalog): boolean {
  const match = BUTTON_RESOURCE.exec(resource ?? '');
  if (!match) return false;
  const [, objectCode, buttonCode, level] = match as unknown as [string, string, string, string];
  const definition = catalog.get(objectCode);
  const effective = mergeObjectPermissions(objectCode, subject.objectPermissions);
  if (!definition || !effective) return false;
  return executableButtons(definition, effective).some((b) => b.buttonCode === buttonCode && b.level === level);
}

export function buttonResource(objectCode: string, buttonCode: string, level: string): string {
  return `${objectCode}#${buttonCode}@${level}`;
}
