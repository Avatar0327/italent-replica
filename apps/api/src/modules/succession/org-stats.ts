/** §4.5 / §4.6：缓存按业务日；授权始终按当前日，历史缓存不是权限入口。 */
import { isUuid, sql, type Tx } from '@italent/db';
import { decide, buttonResource, type OrgId, resolveObjectPermission, tenantLocalDate } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { loadSubject } from '../permission/subject.js';
import { objectCatalog } from '../permission/catalog.js';
import { resolveDataScope } from '../permission/scope-resolver.js';
import { scopeAllows, type ModuleScope } from '../permission/module-access.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { listOrgDescendantsInTransaction } from '../org/hierarchy-reader.js';
import { loadOrgSnapshot, validIsoDate } from '../org/read-model.js';
import { lockOrganizationSettings } from '../org/locks.js';
import type { TalentReviewSyncPort } from '../talent-review/sync-port.js';
import { CalcBlocked, CalcObjectFailure, type CalcHandler } from './calc-contract.js';
import { codeOf, type SuccessionContext } from './access.js';
import { INCUMBENT_EXCLUDED_STATUSES, rowsOf } from './read-sql.js';
import { successionReviewReads } from './ports.js';

async function principal(tx: Tx, tenantId: string) {
  const userId = (await readEffectiveSetting(tx, tenantId, 'succession.system_principal_user_id')).value;
  if (typeof userId !== 'string' || !isUuid(userId)) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  const [active] = rowsOf<{ ok: boolean; today: string }>(
    await tx.execute(sql`SELECT
    succession_calc_user_active(${tenantId}::uuid,${userId}::uuid) AND EXISTS (
      SELECT 1 FROM permission_grants g JOIN permission_profiles p ON p.tenant_id=g.tenant_id AND p.id=g.profile_id
      WHERE g.tenant_id=${tenantId}::uuid AND g.user_id=${userId}::uuid AND g.status='active'
        AND p.code='standard_succession_runner') AS ok, succession_tenant_today(${tenantId}::uuid)::text AS today`),
  );
  if (!active?.ok) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  const subject = await loadSubject(tx, userId, codeOf('map'), { tenantId, userId, asOf: active.today });
  if (
    !decide(subject, { action: 'object.view', resource: codeOf('map') }, objectCatalog) ||
    !resolveObjectPermission(codeOf('map'), subject.objectPermissions, objectCatalog)?.effective.viewableFields.has(
      'stats',
    ) ||
    !decide(
      subject,
      { action: 'object.button', resource: buttonResource(codeOf('map'), 'computeStats', 'list') },
      objectCatalog,
    )
  )
    throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  const scope = await resolveDataScope(tx, {
    tenantId,
    userId,
    appCode: 'SuccessionAndDevelopment',
    objectCode: codeOf('map'),
    asOf: active.today,
  });
  if (!scope.hasDataPermission) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  return { userId, scope };
}
export interface CountContext {
  readonly tenantId: string;
  readonly orgId: string;
  readonly asOf: string;
  readonly runId: string;
  readonly now: Date;
}
async function countOnDuty(tx: Tx, input: CountContext): Promise<number> {
  const descendants = await listOrgDescendantsInTransaction(
    tx,
    { tenantId: input.tenantId, orgId: input.orgId as OrgId, dimension: 'admin', asOf: input.asOf },
    { includeDisabled: false },
  );
  const ids = `{${[input.orgId, ...descendants].join(',')}}`;
  const [row] = rowsOf<{ n: number }>(
    await tx.execute(sql`SELECT count(DISTINCT t.employee_id)::int AS n
    FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    LEFT JOIN LATERAL (SELECT p.id,p.department_id FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.employee_id=r.employee_id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1) latest ON true
    JOIN LATERAL employment_record_status(t.tenant_id,r.id) s ON true
    WHERE t.tenant_id=${input.tenantId}::uuid AND t.valid_during @> ${input.asOf}::date
      AND r.service_type='primary' AND s.employee_status NOT IN (${INCUMBENT_EXCLUDED_STATUSES})
      AND (CASE WHEN latest.id IS NULL THEN r.department_id ELSE latest.department_id END)=ANY(${ids}::uuid[])`),
  );
  return row!.n;
}
async function store(
  tx: Tx,
  input: CountContext,
  count: number,
  slot: string,
  rate: number | null,
  source: string | null,
  actor: string | null,
) {
  const [before] = rowsOf(
    await tx.execute(sql`SELECT on_duty_count AS "onDutyCount",green_rate AS "greenRate"
    FROM succession_org_stats WHERE tenant_id=${input.tenantId}::uuid AND org_id=${input.orgId}::uuid
    AND stat_date=${input.asOf}::date`),
  );
  await tx.execute(sql`INSERT INTO succession_org_stats
    (tenant_id,org_id,stat_date,on_duty_count,green_rate,green_source_project_id,slot_key,computed_at,run_id)
    VALUES (${input.tenantId}::uuid,${input.orgId}::uuid,${input.asOf}::date,${count},${rate},${source}::uuid,
      ${slot},${input.now.toISOString()}::timestamptz,${input.runId}::uuid)
    ON CONFLICT (tenant_id,org_id,stat_date) DO UPDATE SET on_duty_count=excluded.on_duty_count,
      green_rate=excluded.green_rate,green_source_project_id=excluded.green_source_project_id,
      slot_key=excluded.slot_key,computed_at=excluded.computed_at,run_id=excluded.run_id`);
  await recordAudit(tx, {
    tenantId: input.tenantId,
    actorUserId: actor,
    objectType: codeOf('map'),
    objectId: input.orgId,
    action: 'succession.map.stats',
    commandId: `stats:${input.runId}:${input.orgId}:${input.asOf}`,
    occurredAt: input.now,
    scope: { orgId: input.orgId },
    before: before ?? null,
    after: { onDutyCount: count, greenRate: rate, statDate: input.asOf, runId: input.runId },
  });
}
/** 给 B5 的可信读端口；调用方负责授权，在其租户事务内取缓存 / 现算，不自行开事务。 */
export async function readOnDutyCount(tx: Tx, input: CountContext): Promise<number> {
  if (!validIsoDate(input.asOf)) throw new AppError('VALIDATION_FAILED', '业务日期不合法');
  await lockOrganizationSettings(tx, input.tenantId);
  const [row] = rowsOf<{ n: number }>(
    await tx.execute(sql`SELECT on_duty_count AS n FROM succession_org_stats
    WHERE tenant_id=${input.tenantId}::uuid AND org_id=${input.orgId}::uuid AND stat_date=${input.asOf}::date`),
  );
  if (row) return row.n;
  const count = await countOnDuty(tx, input);
  await store(tx, input, count, `history:${input.asOf}`, null, null, null);
  return count;
}
/** §4.5：地图的历史缺缓存同样经 C1 取数；只登记本次确实缺缓存且当前授权的目标来源。 */
export async function cacheHistoricalOnDutyCounts(
  tx: Tx,
  ctx: SuccessionContext,
  scope: ModuleScope,
  orgIds: readonly string[],
  asOf: string,
  createSource: (orgIds: readonly string[]) => Promise<string>,
) {
  if (asOf >= tenantLocalDate(ctx.now, ctx.timezone) || !orgIds.length) return;
  if (orgIds.some((orgId) => !scopeAllows(scope, { orgId }))) throw new AppError('NOT_FOUND', '组织不存在');
  // 与 C1 计数 / worker 共用组织设置锁；并发读取只让首次缺缓存的请求登记来源。
  await lockOrganizationSettings(tx, ctx.tenantId);
  const cached = new Set(
    rowsOf<{ orgId: string }>(
      await tx.execute(sql`SELECT org_id AS "orgId"
    FROM succession_org_stats WHERE tenant_id=${ctx.tenantId}::uuid AND stat_date=${asOf}::date
    AND org_id=ANY(${`{${orgIds.join(',')}}`}::uuid[])`),
    ).map((r) => r.orgId),
  );
  const missing = orgIds.filter((id) => !cached.has(id));
  if (!missing.length) return;
  const runId = await createSource(missing);
  for (const orgId of missing) await readOnDutyCount(tx, { tenantId: ctx.tenantId, orgId, asOf, runId, now: ctx.now });
}
export function createOrgStatsHandler(port?: Pick<TalentReviewSyncPort, 'greenRate'>): CalcHandler {
  return {
    kind: 'org_stats',
    objectType: 'org',
    authorizePage: async ({ tx, run }) => (await principal(tx, run.tenantId)).userId,
    async execute({ tx, run, now }, object) {
      await lockOrganizationSettings(tx, run.tenantId);
      const current = await principal(tx, run.tenantId);
      if (!scopeAllows(current.scope, { orgId: object.objectId }))
        throw new CalcObjectFailure('PRINCIPAL_SCOPE_MISSING', true);
      if (
        !(
          await loadOrgSnapshot(tx, run.tenantId, run.businessDate, undefined, {
            id: object.objectId,
            includeDisabled: false,
          })
        ).length
      )
        throw new CalcObjectFailure('TARGET_NOT_ACTIVE', false);
      const input = { tenantId: run.tenantId, orgId: object.objectId, asOf: run.businessDate, runId: run.id, now };
      const count = await countOnDuty(tx, input);
      const green = (
        await (port ?? successionReviewReads(run.tenantId)).greenRate(tx, {
          tenantId: run.tenantId,
          orgIds: [object.objectId],
          context: { asOf: run.businessDate },
          viewer: { kind: 'principal', userId: current.userId },
        })
      ).get(object.objectId);
      if (!green || green.status === 'forbidden') throw new CalcObjectFailure('SOURCE_FORBIDDEN', true);
      await store(tx, input, count, run.idempotencyKey, green.rate, green.source?.projectId ?? null, current.userId);
      return 'written';
    },
  };
}
export const orgStatsHandler = createOrgStatsHandler();
