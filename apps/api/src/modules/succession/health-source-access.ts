/** §4.1 / P2-2：组织源权限属于来源五态，缓存命中和现算不能成为授权旁路。 */
import type { Tx } from '@italent/db';
import { decide, resolveObjectPermission, MODULE_OBJECTS, ORG_EMPLOYEE_APP } from '@italent/domain';
import type { HealthDependencies } from './health-dependencies.js';
import { loadSubject } from '../permission/subject.js';
import { objectCatalog } from '../permission/catalog.js';
import { resolveDataScope } from '../permission/scope-resolver.js';
import { scopeAllows } from '../permission/module-access.js';

export async function orgHealthSourceStatus(
  tx: Tx,
  dependencies: HealthDependencies,
  input: { tenantId: string; userId: string; orgId: string; today: string },
): Promise<'value' | 'forbidden'> {
  const needsHead = dependencies.reads.has('incumbents');
  const needsOrg = needsHead || dependencies.reads.has('org');
  if (!needsOrg) return 'value';
  const code = MODULE_OBJECTS.organization.code;
  const subject = await loadSubject(tx, input.userId, code, { ...input, asOf: input.today });
  if (!decide(subject, { action: 'object.view', resource: code }, objectCatalog)) return 'forbidden';
  if (
    needsHead &&
    !resolveObjectPermission(code, subject.objectPermissions, objectCatalog)?.effective.viewableFields.has(
      'personInChargeId',
    )
  )
    return 'forbidden';
  // 在岗数是组织派生度量，没有另造字段授权编码；与其他组织源一样复核实际源组织的当前范围。
  const scope = await resolveDataScope(tx, {
    tenantId: input.tenantId,
    userId: input.userId,
    appCode: ORG_EMPLOYEE_APP,
    objectCode: code,
    asOf: input.today,
  });
  return scopeAllows(scope, { orgId: input.orgId }) ? 'value' : 'forbidden';
}
