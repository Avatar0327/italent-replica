/** 当前用户对某对象的有效功能权限（多身份并集，DEC-042；只认登记了对象所属应用的身份）；前台据此显示按钮、列与字段。 */
import type { Tx } from '@italent/db';
import { executableButtons, type ObjectCatalog, resolveObjectPermission } from '@italent/domain';
import { AppError } from '../../errors.js';
import { loadGrantedObjectPermissions } from './subject.js';

export async function myObjectPermission(tx: Tx, userId: string, objectCode: string, catalog: ObjectCatalog) {
  if (!catalog.get(objectCode)) throw new AppError('NOT_FOUND', '对象不存在');
  const resolved = resolveObjectPermission(
    objectCode,
    await loadGrantedObjectPermissions(tx, userId, objectCode),
    catalog,
  );
  // 对象不在任何（应用边界内的）身份对象清单中 = 没有该模块的功能权限 → 后端拒绝（AC-PRM-01）
  if (!resolved) throw new AppError('FORBIDDEN', '无权访问该对象');
  const { definition, effective } = resolved;
  return {
    objectCode,
    dataOperations: effective.dataOperations,
    viewableFields: [...effective.viewableFields].sort(),
    editableFields: [...effective.editableFields].sort(),
    buttons: executableButtons(definition, effective),
  };
}
