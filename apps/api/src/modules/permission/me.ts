import { permissionSet } from './sets.js';
import type { ManagerQuery } from './manager-identity.js';
/** 当前用户对某对象的有效功能权限（多身份并集，DEC-042；只认登记了对象所属应用的身份）；前台据此显示按钮、列与字段。 */
import type { Tx } from '@italent/db';
import {
  EMPLOYEE_SELF_SERVICE_BUTTONS,
  executableButtons,
  type ObjectCatalog,
  type ObjectDefinition,
} from '@italent/domain';
import { tenantObjectCatalog } from './tenant-catalog.js';
import { AppError } from '../../errors.js';
import { createObjectAccess } from './object-access.js';
import { employeeIdentityProfileId } from './employee-identity.js';
import { loadObjectPermissions, loadSubject } from './subject.js';

const EMPLOYMENT_RECORD = 'TenantBase.EmploymentRecord';

export async function myObjectPermission(
  tx: Tx,
  userId: string,
  objectCode: string,
  catalog: ObjectCatalog,
  managerQuery?: ManagerQuery,
) {
  catalog = await tenantObjectCatalog(tx, catalog, objectCode);
  if (!catalog.get(objectCode)) throw new AppError('NOT_FOUND', '对象不存在');
  const subject = await loadSubject(tx, userId, objectCode, managerQuery, { employeeIdentity: true });
  // 与快照、授权器同一判定（object-access.ts）：对象不在任何（应用边界内的）身份对象清单中、也不是有权的配置类对象 → 拒绝（AC-PRM-01）
  const access = await createObjectAccess(tx, userId, subject, catalog).resolve(objectCode);
  if (!access) throw new AppError('FORBIDDEN', '无权访问该对象');
  if (access.kind === 'config') return configObjectPermission(access.definition);
  const { definition, effective } = access.resolved;
  return {
    objectCode,
    dataOperations: effective.dataOperations,
    viewableFields: [...effective.viewableFields].sort(),
    editableFields: [...effective.editableFields].sort(),
    buttons: permissionSet(
      [...executableButtons(definition, effective), ...(await selfServiceButtons(tx, userId, objectCode, managerQuery))],
      ['buttonCode', 'level'],
    ),
  };
}

/**
 * 本人调动的三个按钮由员工身份里是否勾选决定，与本人入口的叠加授权器同一口径（access.ts selfButtonGranted，DEC-402②）：
 * 不看“需要更新 / 新建数据操作”的前提——员工出厂没有任职更新权，但 Employment.Submit 仍是本人调动必需的按钮。
 */
async function selfServiceButtons(tx: Tx, userId: string, objectCode: string, query?: ManagerQuery) {
  if (objectCode !== EMPLOYMENT_RECORD || !query) return [];
  const profileId = await employeeIdentityProfileId(tx, query.tenantId, userId);
  if (!profileId) return [];
  const [permission] = await loadObjectPermissions(tx, [profileId], objectCode);
  const own = new Set(EMPLOYEE_SELF_SERVICE_BUTTONS.map((b) => b.buttonCode));
  return (permission?.buttons ?? []).filter((b) => b.level === 'detail' && own.has(b.buttonCode));
}

/** 配置类对象：与授权器一致——可查看全部字段、可新增 / 编辑非系统字段、不可删除、没有按钮。 */
function configObjectPermission(definition: ObjectDefinition) {
  return {
    objectCode: definition.code,
    dataOperations: { create: true, update: true, delete: false },
    viewableFields: definition.fields.map((f) => f.code).sort(),
    editableFields: definition.fields
      .filter((f) => !f.system)
      .map((f) => f.code)
      .sort(),
    buttons: [],
  };
}
