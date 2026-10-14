/** §4.0 / SP-01：身份与范围每次从当前租户事务重验，不把源读取授权当作目标写授权。 */
import { isUuid, sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction, scopeAllows } from '../permission/module-access.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import type { SyncErrorCode } from '../talent-review/sync-port.js';
import { codeOf } from './access.js';
import { rowsOf, selfTargetSql } from './read-sql.js';

export class PlanFailure extends Error {
  constructor(
    readonly code: SyncErrorCode,
    readonly params: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
  }
}
export interface PlanTarget {
  kind: 'org' | 'position' | 'org_health';
  id: string;
}
export const targetKey = (t: PlanTarget) => `${t.kind}:${t.id}`;
export type AccessDeps = Pick<TenantRouteDeps, 'authorize' | 'clock'>;
export async function activeUser(tx: Tx, tenantId: string, userId: string): Promise<boolean> {
  if (!isUuid(userId)) return false;
  return (
    rowsOf<{ active: boolean }>(
      await tx.execute(sql`SELECT
    succession_calc_user_active(${tenantId}::uuid,${userId}::uuid) AS active`),
    )[0]?.active === true
  );
}
export async function targetAt(tx: Tx, tenant: string, target: PlanTarget, date: string) {
  const position = target.kind === 'position';
  const table = sql.identifier(position ? 'job_position_versions' : 'org_versions');
  const id = sql.identifier(position ? 'object_id' : 'org_id');
  return rowsOf<{ org_id: string; enabled: boolean; current: boolean; is_key: boolean }>(
    await tx.execute(sql`
    SELECT org_id, enabled, stop_date >= ${date}::date AS current,
      ${position ? sql`is_key` : sql`true`} AS is_key FROM ${table}
    WHERE tenant_id=${tenant}::uuid AND ${id}=${target.id}::uuid AND start_date<=${date}::date
    ORDER BY start_date DESC,version_no DESC LIMIT 1`),
  )[0];
}
/** 只按当前归属锚点判授权；冻结业务日期仅用于目标有效性（DEC-368①）。 */
export async function targetAccess(deps: AccessDeps, tx: Tx, tenantId: string, timezone: string, userId: string) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  const ctx = { tenantId, timezone, userId };
  const today = tenantLocalDate(deps.clock(), timezone);
  const scopes = new Map<string, Awaited<ReturnType<typeof resolveModuleScopeInTransaction>>>();
  const allowed = async (object: 'record' | 'healthResult' | 'riskResult', operations: readonly string[]) => {
    const resource = codeOf(object);
    for (const operation of operations) {
      const fields = object === 'healthResult' && operation === 'update' ? ['levelId'] : [];
      if (!(await authorize({ ...ctx, action: `object.${operation}`, resource, fields }))) return false;
    }
    if (!scopes.has(resource))
      scopes.set(resource, await resolveModuleScopeInTransaction({ ...deps, authorize }, ctx, tx, resource));
    return scopes.get(resource)!.hasDataPermission;
  };
  return {
    today,
    allowed,
    async covers(target: PlanTarget) {
      const object = target.kind === 'org_health' ? 'healthResult' : 'record';
      if (!(await allowed(object, object === 'record' ? ['create', 'update'] : ['update']))) return false;
      const current = await targetAt(tx, tenantId, target, today);
      // 不存在的组织仍有稳定范围锚点，存在性由规划单独产生 TARGET_NOT_FOUND。
      const orgId = target.kind === 'position' ? current?.org_id : target.id;
      return scopeAllows(scopes.get(codeOf(object))!, { orgId });
    },
  };
}
/** §8.3/8.4：人工驱动共用目标写授权；SELF 继任记录沿用命令前 404 的保守口径。 */
export async function authorizeRequesterTargets(
  deps: AccessDeps,
  tx: Tx,
  ctx: { tenantId: string; timezone: string; userId: string },
  targets: readonly PlanTarget[],
) {
  const access = await targetAccess(deps, tx, ctx.tenantId, ctx.timezone, ctx.userId);
  let covered = await activeUser(tx, ctx.tenantId, ctx.userId);
  for (const target of targets) if (!(await access.covers(target))) covered = false;
  if (!covered) throw new AppError('FORBIDDEN', '执行集合超出当前范围', { reason: 'BATCH_SCOPE_EXCEEDS_REQUESTER' });
  for (const target of targets) {
    // SELF 写限制作用于继任记录；健康度结果仍按自身对象范围授权（§8.3）。
    if (target.kind === 'org_health') continue;
    const [row] = rowsOf<{ self: boolean }>(
      await tx.execute(
        sql`SELECT ${selfTargetSql(
          ctx,
          {
            type: sql`${target.kind}`,
            org: sql`${target.kind === 'org' ? target.id : null}`,
            position: sql`${target.kind === 'position' ? target.id : null}`,
          },
          access.today,
        )} AS self`,
      ),
    );
    if (row?.self) throw new AppError('NOT_FOUND', '继任记录不存在');
  }
}
export async function writerAccess(deps: AccessDeps, tx: Tx, tenantId: string, timezone: string) {
  const value = (await readEffectiveSetting(tx, tenantId, 'succession.system_principal_user_id')).value;
  const unavailable = () => new PlanFailure('PRINCIPAL_UNAVAILABLE', { principal: 'write' });
  if (typeof value !== 'string' || !(await activeUser(tx, tenantId, value))) throw unavailable();
  const granted = rowsOf(
    await tx.execute(sql`SELECT 1 FROM permission_grants g JOIN permission_profiles p
    ON p.tenant_id=g.tenant_id AND p.id=g.profile_id WHERE g.tenant_id=${tenantId}::uuid
    AND g.user_id=${value}::uuid AND g.status='active' AND p.source='standard'
    AND p.code='standard_succession_runner' LIMIT 1`),
  );
  if (!granted.length) throw unavailable();
  const access = await targetAccess(deps, tx, tenantId, timezone, value);
  for (const object of ['record', 'riskResult', 'healthResult'] as const) {
    if (!(await access.allowed(object, object === 'record' ? ['create', 'update'] : ['update']))) throw unavailable();
  }
  return { userId: value, ...access };
}
