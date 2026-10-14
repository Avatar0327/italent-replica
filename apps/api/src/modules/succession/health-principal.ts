/** §4.0：系统主体是所属人；每页与目标锁内重复解析当前身份、字段权和范围。 */
import { isUuid, sql, type Tx } from '@italent/db';
import { decide, buttonResource, resolveObjectPermission } from '@italent/domain';
import { loadSubject } from '../permission/subject.js';
import { objectCatalog } from '../permission/catalog.js';
import { resolveDataScope } from '../permission/scope-resolver.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { CalcBlocked } from './calc-contract.js';
import { codeOf } from './access.js';
import { rowsOf } from './read-sql.js';
export async function healthPrincipal(tx: Tx, tenantId: string, reset: boolean) {
  const userId = (await readEffectiveSetting(tx, tenantId, 'succession.system_principal_user_id')).value;
  if (typeof userId !== 'string' || !isUuid(userId)) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  const [active] = rowsOf<{ ok: boolean; today: string; timezone: string }>(
    await tx.execute(sql`SELECT
    succession_calc_user_active(${tenantId}::uuid,${userId}::uuid) AND EXISTS (
      SELECT 1 FROM permission_grants g JOIN permission_profiles p ON p.tenant_id=g.tenant_id AND p.id=g.profile_id
      WHERE g.tenant_id=${tenantId}::uuid AND g.user_id=${userId}::uuid AND g.status='active'
      AND p.code='standard_succession_runner') AS ok,
    succession_tenant_today(${tenantId}::uuid)::text AS today,current_tenant_timezone() AS timezone`),
  );
  if (!active?.ok) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  const subject = await loadSubject(tx, userId, codeOf('healthResult'), { tenantId, userId, asOf: active.today });
  const permission = resolveObjectPermission(codeOf('healthResult'), subject.objectPermissions, objectCatalog);
  if (
    !decide(
      subject,
      { action: 'object.update', resource: codeOf('healthResult'), fields: ['levelId'] },
      objectCatalog,
    ) ||
    !permission?.effective.editableFields.has('levelId') ||
    (reset &&
      !decide(
        subject,
        { action: 'object.button', resource: buttonResource(codeOf('healthResult'), 'reset', 'list') },
        objectCatalog,
      ))
  )
    throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  const scope = await resolveDataScope(tx, {
    tenantId,
    userId,
    appCode: 'SuccessionAndDevelopment',
    objectCode: codeOf('healthResult'),
    asOf: active.today,
  });
  if (!scope.hasDataPermission) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  return { userId, scope, today: active.today, timezone: active.timezone };
}
