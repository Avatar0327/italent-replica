/** Real functional authorizer plus its data-scope/field provider (DEC-080). No implicit admin data bypass. */
import { type Db, type Tx, withTenant } from '@italent/db';
import { decide, MODULE_ACTIONS, MODULE_OBJECTS, type ObjectCatalog, resolveObjectPermission } from '@italent/domain';
import type { Authorizer } from '../../authorization.js';
import { objectCatalog } from './catalog.js';
import { registerScopeProvider } from './module-access.js';
import { resolveDataScope } from './scope-resolver.js';
import { loadSubject } from './subject.js';
import { tenantObjectCatalog } from './tenant-catalog.js';

const CONFIG_OBJECTS = new Set<string>([
  MODULE_OBJECTS.employmentSettings.code,
  MODULE_OBJECTS.employmentCustomField.code,
]);
export function createPermissionAuthorizer(db: Db, catalog: ObjectCatalog = objectCatalog): Authorizer {
  const evaluate = async (request: Parameters<Authorizer>[0], tx: Tx): Promise<boolean> => {
    const objectCode = objectOf(request.action, request.resource);
    const subject = await loadSubject(tx, request.userId, objectCode);
    const currentCatalog = await tenantObjectCatalog(tx, catalog, objectCode);
    if (objectCode && CONFIG_OBJECTS.has(objectCode)) {
      if (!decide(subject, { action: 'admin.other_settings' }, currentCatalog)) return false;
      if (request.action === 'object.view') return true;
      if (!['object.create', 'object.update'].includes(request.action) || !request.fields) return false;
      const writable = new Set(
        currentCatalog
          .get(objectCode)
          ?.fields.filter((f) => !f.system)
          .map((f) => f.code),
      );
      return request.fields.every((field) => writable.has(field));
    }
    return decide(subject, request, currentCatalog);
  };
  const authorize: Authorizer = (request) => withTenant(db, request.tenantId, (tx) => evaluate(request, tx));
  registerScopeProvider(authorize, {
    authorize: evaluate,
    scope: (query) => withTenant(db, query.tenantId, (tx) => resolveDataScope(tx, query)),
    // 调用方已在租户事务内时沿用该事务（审批流转内要解析其他审批人的字段权限，R1-T07 第二轮清单 5）。
    fields: (tenantId, userId, objectCode, tx) =>
      tx
        ? viewableFields(tx, userId, objectCode)
        : withTenant(db, tenantId, (t) => viewableFields(t, userId, objectCode)),
  });
  async function viewableFields(tx: Tx, userId: string, objectCode: string): Promise<ReadonlySet<string>> {
    const subject = await loadSubject(tx, userId, objectCode);
    const currentCatalog = await tenantObjectCatalog(tx, catalog, objectCode);
    if (CONFIG_OBJECTS.has(objectCode) && decide(subject, { action: 'admin.other_settings' }, currentCatalog)) {
      return new Set(currentCatalog.get(objectCode)?.fields.map((f) => f.code));
    }
    return (
      resolveObjectPermission(objectCode, subject.objectPermissions, currentCatalog)?.effective.viewableFields ??
      new Set()
    );
  }
  return authorize;
}
function objectOf(action: string, resource: string | undefined): string | undefined {
  if (action.startsWith('object.')) return resource?.split('#')[0];
  const mapped = MODULE_ACTIONS[action];
  return mapped?.kind === 'object' ? mapped.objectCode : undefined;
}
