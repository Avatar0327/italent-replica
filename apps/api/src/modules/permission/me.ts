/** 当前用户对某对象的有效功能权限（多身份并集，DEC-042）；前台据此显示按钮、列表列与表单字段。 */
import type { Tx } from '@italent/db';
import { executableButtons, mergeObjectPermissions, type ObjectCatalog } from '@italent/domain';
import { AppError } from '../../errors.js';
import { loadActiveProfileIds, loadObjectPermissions } from './subject.js';

export async function myObjectPermission(tx: Tx, userId: string, objectCode: string, catalog: ObjectCatalog) {
  const definition = catalog.get(objectCode);
  if (!definition) throw new AppError('NOT_FOUND', '对象不存在');
  const permissions = await loadObjectPermissions(tx, await loadActiveProfileIds(tx, userId), objectCode);
  const effective = mergeObjectPermissions(objectCode, permissions);
  // 对象不在任何身份的对象清单中 = 没有该模块的功能权限 → 后端拒绝（AC-PRM-01）
  if (!effective) throw new AppError('FORBIDDEN', '无权访问该对象');
  return {
    objectCode,
    dataOperations: effective.dataOperations,
    viewableFields: [...effective.viewableFields].sort(),
    editableFields: [...effective.editableFields].sort(),
    buttons: executableButtons(definition, effective),
  };
}
