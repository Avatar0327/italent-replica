/**
 * 功能权限判定（R1-T01）：把授权钩子的 action / resource 映射为管理员能力或对象权限，默认拒绝（fail-closed）。
 * action 语法：
 *   admin.<能力>                     L2 企业设置能力（admin-roles.ts）
 *   object.view|delete              resource = 对象编码；view = 对象在任一身份的对象清单中
 *   object.create|update            同上，且必须给出要写的字段 fields：每个字段都须可编辑（缺 fields 即拒绝）
 *   object.button                   resource = `<对象编码>#<按钮编码>@<级别>`
 *   tenant.<模块>.*                  已上线模块的路由动作，按 module-actions.ts 登记表映射
 * 对象须已登记到对象目录，且只认“身份登记了对象所属应用”的权限（应用边界）。
 * 未知 action、格式不对的 resource 一律拒绝。只判定功能权限；数据范围由 R1-T02 判定（DEC-043）。
 */
import { type AdminRole, hasAdminCapability, isAdminCapability } from './admin-roles.js';
import {
  executableButtons,
  fieldWriteViolations,
  type GrantedObjectPermission,
  type ResolvedObjectPermission,
  resolveObjectPermission,
} from './effective.js';
import { MODULE_ACTIONS } from './module-actions.js';
import { BUTTON_LEVELS, type DataOperation, type ObjectCatalog } from './object-permission.js';

export interface PermissionSubject {
  readonly adminRoles: readonly AdminRole[];
  /** 用户全部有效授权所对应身份的对象权限（未合并，带身份登记的应用）。 */
  readonly objectPermissions: readonly GrantedObjectPermission[];
}

export interface PermissionQuery {
  readonly action: string;
  readonly resource?: string | undefined;
  /** 写入的字段编码（object.create / object.update 必填；服务端按载荷实际字段给出，不信任前台）。 */
  readonly fields?: readonly string[] | undefined;
}

type ObjectOperation = 'view' | DataOperation;

const OBJECT_ACTIONS: Readonly<Record<string, ObjectOperation>> = {
  'object.view': 'view',
  'object.create': 'create',
  'object.update': 'update',
  'object.delete': 'delete',
};

export function decide(subject: PermissionSubject, query: PermissionQuery, catalog: ObjectCatalog): boolean {
  const { action } = query;
  if (action.startsWith('admin.')) return decideAdmin(subject, action.slice('admin.'.length));
  if (action === 'object.button') return decideButton(subject, query.resource, catalog);

  const op = OBJECT_ACTIONS[action];
  if (op !== undefined) {
    if (!query.resource) return false;
    const resolved = resolveObjectPermission(query.resource, subject.objectPermissions, catalog);
    // 新增 / 编辑是写字段的操作：不给字段集合就无法校验字段权限，拒绝
    const fields = op === 'create' || op === 'update' ? query.fields : [];
    return fields !== undefined && allows(resolved, op, fields);
  }

  const mapped = MODULE_ACTIONS[action];
  if (mapped === undefined) return false;
  if (mapped.kind === 'admin') return decideAdmin(subject, mapped.capability);
  const resolved = resolveObjectPermission(mapped.objectCode, subject.objectPermissions, catalog);
  // DEC-080：模块别名同样不能以缺失字段集绕过写入校验。
  const fields = mapped.operation === 'create' || mapped.operation === 'update' ? query.fields : [];
  return fields !== undefined && allows(resolved, mapped.operation, fields);
}

function allows(resolved: ResolvedObjectPermission | undefined, op: ObjectOperation, fields: readonly string[]) {
  if (!resolved) return false;
  if (op !== 'view' && !resolved.effective.dataOperations[op]) return false;
  return fieldWriteViolations(resolved, fields).length === 0;
}

function decideAdmin(subject: PermissionSubject, capability: string): boolean {
  return isAdminCapability(capability) && hasAdminCapability(subject.adminRoles, capability);
}

const BUTTON_RESOURCE = new RegExp(`^([^#]+)#([^@]+)@(${BUTTON_LEVELS.join('|')})$`);

function decideButton(subject: PermissionSubject, resource: string | undefined, catalog: ObjectCatalog): boolean {
  const match = BUTTON_RESOURCE.exec(resource ?? '');
  if (!match) return false;
  const [, objectCode, buttonCode, level] = match as unknown as [string, string, string, string];
  const resolved = resolveObjectPermission(objectCode, subject.objectPermissions, catalog);
  if (!resolved) return false;
  return executableButtons(resolved.definition, resolved.effective).some(
    (b) => b.buttonCode === buttonCode && b.level === level,
  );
}

export function buttonResource(objectCode: string, buttonCode: string, level: string): string {
  return `${objectCode}#${buttonCode}@${level}`;
}
