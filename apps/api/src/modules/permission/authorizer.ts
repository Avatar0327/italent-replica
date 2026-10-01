/**
 * 真实授权器（替换 R1-T00 的“R1-T01 接入”钩子）：每次请求按用户在当前租户的管理员身份与业务身份判定，
 * 默认拒绝（fail-closed）。只判定功能权限；数据范围由 R1-T02 判定（DEC-043）。
 */
import { type Db, withTenant } from '@italent/db';
import { decide, type ObjectCatalog } from '@italent/domain';
import type { Authorizer } from '../../authorization.js';
import { objectCatalog } from './catalog.js';
import { loadSubject } from './subject.js';

export function createPermissionAuthorizer(db: Db, catalog: ObjectCatalog = objectCatalog): Authorizer {
  return async (request) => {
    // 对象类动作只需加载该对象的权限；管理员能力与对象无关
    const objectCode = request.action.startsWith('object.') ? request.resource?.split('#')[0] : undefined;
    const subject = await withTenant(db, request.tenantId, (tx) => loadSubject(tx, request.userId, objectCode));
    return decide(subject, request, catalog);
  };
}
