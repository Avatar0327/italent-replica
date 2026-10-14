/** #7 / §8.4：组织与嵌套职位共用卡片数据，记录、结果各自按当前授权裁剪。 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import type { TenantRouteDeps } from '../../routes.js';
import {
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
  scopeAllows,
  scopeSql,
  type ModuleScope,
} from '../permission/module-access.js';
import { codeOf, type SuccessionContext } from './access.js';
import { buildRecordViews, projectSuccession } from './projection.js';
import { listMapRecordRows } from './record-read.js';
import { loadIncumbentIds, loadPeople, rowsOf, selfRecordHiddenSql } from './read-sql.js';
import { enqueueCalcRun } from './calc-worker.js';
import { cacheHistoricalOnDutyCounts } from './org-stats.js';
import { readRiskRows, projectRisk } from './risk-store.js';
import { projectHealth, readHealthResults } from './health-results.js';

export const fieldVisible = (fields: ReadonlySet<string> | undefined, key: string) =>
  fields === undefined || fields.has(key);
export interface CardTarget {
  readonly id: string;
  readonly type: 'org' | 'position';
}
export interface MapPosition {
  readonly id: string;
  readonly name: string;
  readonly orgId: string;
}
/** 业务版本按 asOf，范围锚点按今天所属组织（DEC-368①）；不让历史组织位置绕过当前权限。 */
export async function loadMapPositions(
  tx: Tx,
  tenantId: string,
  orgIds: readonly string[],
  scope: ModuleScope,
  asOf: string,
  today: string,
) {
  if (!orgIds.length) return [];
  // 与 Record 当前范围锚点一致：无当前有效归属时，仅显式看全部可读历史节点。
  return rowsOf<MapPosition>(
    await tx.execute(sql`SELECT v.object_id AS id,v.name,v.org_id AS "orgId"
      FROM (SELECT DISTINCT ON (object_id) * FROM job_position_versions
        WHERE tenant_id=${tenantId}::uuid AND start_date<=${asOf}::date
        ORDER BY object_id,start_date DESC,version_no DESC) v
      LEFT JOIN LATERAL (SELECT org_id,stop_date FROM job_position_versions p
        WHERE p.tenant_id=v.tenant_id AND p.object_id=v.object_id AND p.start_date<=${today}::date
        ORDER BY p.start_date DESC,p.version_no DESC LIMIT 1) current ON current.stop_date>=${today}::date
      WHERE v.enabled AND v.is_key AND v.stop_date>=${asOf}::date
        AND v.org_id=ANY(${`{${orgIds.join(',')}}`}::uuid[])
        AND ${scopeSql(scope, { org: sql`current.org_id` })}
      ORDER BY v.display_order ASC NULLS LAST,v.code,v.object_id`),
  );
}
export async function mapObjectAccess(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  kind: 'record' | 'healthResult' | 'riskResult',
) {
  if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf(kind), fields: [] }))) return null;
  return {
    scope: await resolveModuleScopeInTransaction(deps, ctx, tx, codeOf(kind)),
    fields: await getModuleViewableFieldsInTransaction(deps, ctx, codeOf(kind), tx),
  };
}
/** 即使没有继任记录也要判目标 SELF，不能用“过滤后计数为 0”替代键缺席。 */
export async function hiddenMapTargets(tx: Tx, ctx: SuccessionContext, targets: readonly CardTarget[], today: string) {
  const hidden = new Set<string>();
  for (const type of ['org', 'position'] as const) {
    const ids = targets.filter((t) => t.type === type).map((t) => t.id);
    if (!ids.length) continue;
    const rows = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT id FROM unnest(${`{${ids.join(',')}}`}::uuid[]) AS targets(id)
      WHERE ${selfRecordHiddenSql(
        ctx,
        {
          type: sql`${type}`,
          org: type === 'org' ? sql`id` : sql`NULL`,
          position: type === 'position' ? sql`id` : sql`NULL`,
        },
        today,
      )}`),
    );
    for (const row of rows) hidden.add(row.id);
  }
  return hidden;
}
export async function readMapSuccessors(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  targets: readonly CardTarget[],
  asOf: string,
  today: string,
  access: Awaited<ReturnType<typeof mapObjectAccess>>,
) {
  const result = new Map<string, { successors: object[]; count: number }>();
  if (!access) return result;
  const rows = await listMapRecordRows(
    tx,
    { ...ctx, scope: access.scope, asOf, today },
    {
      orgIds: targets.filter((t) => t.type === 'org').map((t) => t.id),
      positionIds: targets.filter((t) => t.type === 'position').map((t) => t.id),
    },
  );
  const projected = await projectSuccession(
    deps,
    ctx,
    'record',
    await buildRecordViews(tx, ctx.tenantId, rows, asOf),
    tx,
  );
  rows.forEach((row, index) => {
    const id = (row.targetOrgId ?? row.targetPositionId)!;
    const group = result.get(id) ?? { successors: [], count: 0 };
    // 现任信息只在卡片自己的受控键展示；嵌套记录不能重新挂回被租户开关隐藏的现任。
    const { incumbents: _incumbents, personInCharge: _head, ...successor } = projected[index]!;
    group.successors.push(successor);
    group.count++;
    result.set(id, group);
  });
  return result;
}
export async function mapIncumbents(tx: Tx, tenantId: string, positionIds: readonly string[], asOf: string) {
  const incumbents = await loadIncumbentIds(tx, tenantId, positionIds, asOf);
  const people = await loadPeople(tx, tenantId, [...incumbents.values()].flat());
  return new Map([...incumbents].map(([id, ids]) => [id, ids.flatMap((employeeId) => people.get(employeeId) ?? [])]));
}
export async function readMapHealth(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  orgIds: readonly string[],
  asOf: string,
) {
  const access = await mapObjectAccess(tx, deps, ctx, 'healthResult');
  const ids = access ? orgIds.filter((orgId) => scopeAllows(access.scope, { orgId })) : [];
  const result = new Map<string, object>();
  if (!ids.length) return result;
  const { views } = await readHealthResults(tx, deps, ctx, { limit: ids.length, offset: 0 }, ids, asOf);
  const projected = await projectHealth(deps, ctx, views, tx);
  views.forEach((view, index) => {
    const item = projected[index]!;
    result.set(view.orgId, {
      ...item,
      // resultAsOf 是 computedAt 的别名，不能绕过结果对象的字段权限。
      ...(fieldVisible(access!.fields, 'computedAt')
        ? { resultAsOf: view.computedAt ? new Date(view.computedAt).toISOString() : null }
        : {}),
    });
  });
  return result;
}
export async function readMapStats(
  tx: Tx,
  ctx: SuccessionContext,
  scope: ModuleScope,
  orgIds: readonly string[],
  asOf: string,
) {
  await cacheHistoricalOnDutyCounts(tx, ctx, scope, orgIds, asOf, (missing) =>
    enqueueCalcRun(
      tx,
      {
        tenantId: ctx.tenantId,
        kind: 'org_stats',
        trigger: 'manual',
        requestedBy: ctx.userId,
        commandId: `history:${asOf}:${randomUUID()}`,
        businessDate: asOf,
        objects: missing.map((objectId) => ({ objectType: 'org', objectId })),
      },
      ctx.now,
    ),
  );
  const tenantId = ctx.tenantId;
  const rows = orgIds.length
    ? rowsOf<{ orgId: string; onDutyCount: number; greenRate: string | null }>(
        await tx.execute(sql`SELECT org_id AS "orgId",on_duty_count AS "onDutyCount",green_rate AS "greenRate"
      FROM succession_org_stats WHERE tenant_id=${tenantId}::uuid AND stat_date=${asOf}::date
      AND org_id=ANY(${`{${orgIds.join(',')}}`}::uuid[])`),
      )
    : [];
  const cached = new Map(rows.map((row) => [row.orgId, row]));
  // §4.5：历史缺缓存由 C1 统一补齐；当前日沿用定时缓存，编制方案 / 周期尚未定，显示 --。
  return new Map(
    orgIds.map((orgId) => {
      const row = cached.get(orgId);
      return [
        orgId,
        {
          onDutyCount: row?.onDutyCount ?? null,
          greenRate: row?.greenRate == null ? null : Number(row.greenRate),
          capacity: '--',
          statDate: asOf,
        },
      ];
    }),
  );
}

export async function readMapRisk(tx: Tx, deps: TenantRouteDeps, ctx: SuccessionContext, ids: readonly string[]) {
  const access = await mapObjectAccess(tx, deps, ctx, 'riskResult');
  const result = new Map<string, object>();
  if (!access || !ids.length) return result;
  const { views } = await readRiskRows(tx, deps, ctx, ids, { limit: ids.length, offset: 0 }, true);
  const projected = await projectRisk(deps, ctx, views, tx);
  views.forEach((view, index) =>
    result.set(view.positionId, {
      ...projected[index],
      ...(fieldVisible(access.fields, 'computedAt')
        ? { resultAsOf: view.computedAt ? new Date(view.computedAt).toISOString() : null }
        : {}),
    }),
  );
  return result;
}
