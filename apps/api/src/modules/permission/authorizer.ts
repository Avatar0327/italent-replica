/** Real functional authorizer plus its data-scope/field provider (DEC-080). No implicit admin data bypass. */
import { type Db, type Tx, withTenant, getTenant, permissionAdmins, and, eq } from '@italent/db';
import {
  tenantLocalDate,
  decide,
  MODULE_ACTIONS,
  MODULE_OBJECTS,
  type ObjectCatalog,
  resolveObjectPermission,
} from '@italent/domain';
import type { Authorizer } from '../../authorization.js';
import { objectCatalog } from './catalog.js';
import { registerScopeProvider } from './module-access.js';
import { resolveDataScope } from './scope-resolver.js';
import { loadSubject } from './subject.js';
import { tenantObjectCatalog } from './tenant-catalog.js';

const CONFIG_OBJECTS = new Set<string>([
  MODULE_OBJECTS.employmentSettings.code,
  MODULE_OBJECTS.employmentCustomField.code,
  MODULE_OBJECTS.contractSettings.code,
  MODULE_OBJECTS.contractRules.code,
]);
export function createPermissionAuthorizer(
  db: Db,
  catalog: ObjectCatalog = objectCatalog,
  clock: () => Date = () => new Date(),
): Authorizer {
  // 仅缓存平台层时区（每个外层验权请求刷新）；成员、身份与范围始终实时读取。
  // 租户事务的应用角色无权读取平台 tenants 表，写入口沿用已认证上下文中的时区。
  const timezones = new Map<string, string>();
  const evaluate = async (request: Parameters<Authorizer>[0], tx: Tx): Promise<boolean> => {
    const objectCode = objectOf(request.action, request.resource);
    const subject = await loadSubject(tx, request.userId, objectCode, {
      tenantId: request.tenantId,
      userId: request.userId,
      asOf: tenantLocalDate(clock(), request.timezone ?? timezones.get(request.tenantId) ?? 'UTC'),
    });
    const currentCatalog = await tenantObjectCatalog(tx, catalog, objectCode);
    if (objectCode && CONFIG_OBJECTS.has(objectCode)) {
      if (!(await configAllowed(tx, request.userId, objectCode, subject, currentCatalog))) return false;
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
  const authorize: Authorizer = async (request) => {
    const tenant = await getTenant(db, request.tenantId);
    if (!tenant) return false;
    timezones.set(request.tenantId, tenant.timezone);
    return withTenant(db, request.tenantId, (tx) => evaluate({ ...request, timezone: tenant.timezone }, tx));
  };
  registerScopeProvider(authorize, {
    authorize: evaluate,
    scope: (query, tx) =>
      tx ? resolveDataScope(tx, query) : withTenant(db, query.tenantId, (t) => resolveDataScope(t, query)),
    // 调用方已在租户事务内时沿用该事务（审批流转内要解析其他审批人的字段权限，R1-T07 第二轮清单 5）。
    editableFields: (tenantId, userId, objectCode, tx, asOf) =>
      viewableFields(tx, tenantId, userId, objectCode, asOf, true),
    fields: (tenantId, userId, objectCode, tx, asOf) =>
      tx
        ? viewableFields(tx, tenantId, userId, objectCode, asOf)
        : withTenant(db, tenantId, (t) => viewableFields(t, tenantId, userId, objectCode, asOf)),
  });
  async function viewableFields(
    tx: Tx,
    tenantId: string,
    userId: string,
    objectCode: string,
    asOf?: string,
    editable = false,
  ): Promise<ReadonlySet<string>> {
    const subject = await loadSubject(tx, userId, objectCode, {
      tenantId,
      userId,
      asOf: asOf ?? tenantLocalDate(clock(), timezones.get(tenantId) ?? 'UTC'),
    });
    const currentCatalog = await tenantObjectCatalog(tx, catalog, objectCode);
    if (CONFIG_OBJECTS.has(objectCode) && (await configAllowed(tx, userId, objectCode, subject, currentCatalog))) {
      return new Set(currentCatalog.get(objectCode)?.fields.map((f) => f.code));
    }
    return (
      resolveObjectPermission(objectCode, subject.objectPermissions, currentCatalog)?.effective[
        editable ? 'editableFields' : 'viewableFields'
      ] ?? new Set()
    );
  }
  return authorize;
}
function objectOf(action: string, resource: string | undefined): string | undefined {
  if (action.startsWith('object.')) return resource?.split('#')[0];
  const mapped = MODULE_ACTIONS[action];
  return mapped?.kind === 'object' ? mapped.objectCode : undefined;
}

async function configAllowed(
  tx: Tx,
  userId: string,
  objectCode: string,
  subject: Awaited<ReturnType<typeof loadSubject>>,
  catalog: ObjectCatalog,
) {
  if (![MODULE_OBJECTS.contractSettings.code, MODULE_OBJECTS.contractRules.code].includes(objectCode))
    return decide(subject, { action: 'admin.other_settings' }, catalog);
  if (subject.adminRoles.includes('tenant_admin')) return true;
  const records = await tx
    .select({ id: permissionAdmins.id })
    .from(permissionAdmins)
    .where(
      and(
        eq(permissionAdmins.userId, userId),
        eq(permissionAdmins.status, 'active'),
        eq(permissionAdmins.contractConfiguration, true),
      ),
    )
    .limit(1);
  return records.length > 0;
}
