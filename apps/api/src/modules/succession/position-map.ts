/** C3：设计 §5.6 / §5.8 / §8.2；集合复用 C1，人员展示复用 A1，风险读侧复用 B4。 */
import { sql, type Tx } from '@italent/db';
import type { TenantRouteDeps } from '../../routes.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
  scopeAllows,
} from '../permission/module-access.js';
import { codeOf, type SuccessionContext } from './access.js';
import { mapPositions, readMapDisplayScope, readPositionMapStructure } from './map-display.js';
import { readPreferences, readMapTenantSettings } from './map-preferences.js';
import { settingsView } from './config-store.js';
import { riskRead, projectRiskViews, type RiskView } from './risk-store.js';
import { loadIncumbentIds, loadPeople, rowsOf, selfRecordHiddenSql } from './read-sql.js';

interface MapSuccessor {
  id: string;
  positionId: string;
  employeeId: string;
  backupType: string;
  startDate: string;
  readiness: { id: string; code: string; name: string; color: string } | null;
}
async function readMapSuccessors(tx: Tx, ctx: SuccessionContext, ids: readonly string[], asOf: string, today: string) {
  return rowsOf<MapSuccessor>(
    await tx.execute(sql`SELECT r.id,r.target_position_id AS "positionId",
      r.successor_employee_id AS "employeeId",r.backup_type AS "backupType",r.start_date::text AS "startDate",
      CASE WHEN l.id IS NULL THEN NULL ELSE json_build_object(
        'id',l.id,'code',l.code,'name',l.name,'color',l.color) END AS readiness
      FROM succession_records r LEFT JOIN talent_readiness_levels l ON l.tenant_id=r.tenant_id AND l.id=r.readiness_id
      WHERE r.tenant_id=${ctx.tenantId}::uuid AND r.succession_type='position'
      AND r.target_position_id=ANY(${`{${ids.join(',')}}`}::uuid[])
      AND r.deleted_at IS NULL AND r.start_date<=${asOf}::date AND r.end_date>${asOf}::date
      AND NOT ${selfRecordHiddenSql(
        ctx,
        {
          type: sql`r.succession_type`,
          org: sql`r.target_org_id`,
          position: sql`r.target_position_id`,
        },
        today,
      )} ORDER BY r.start_date,r.created_at,r.id`),
  );
}
/** 没有风险查看权时键缺席；默认颜色也属于风险对象，不能借 Map 的看全部扩大披露。 */
async function positionRiskCards(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  ids: readonly string[],
  today: string,
) {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const cards = new Map<string, Record<string, unknown>>();
  if (!(await bound.authorize({ ...ctx, action: 'object.view', resource: codeOf('riskResult'), fields: [] })))
    return cards;
  const scope = await resolveModuleScopeInTransaction(bound, ctx, tx, codeOf('riskResult'));
  const current = await mapPositions(tx, ctx.tenantId, today, scope);
  const permitted = new Set(current.filter((p) => scopeAllows(scope, { orgId: p.orgId })).map((p) => p.id));
  const settings = await settingsView(tx, ctx.tenantId, 'position_risk');
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    const { views } = await riskRead(tx, bound, ctx, batch);
    const byId = new Map(views.map((v) => [v.positionId, v]));
    const wanted = batch.flatMap<Pick<RiskView, 'positionId' | 'levelId' | 'levelName' | 'levelColor' | 'computedAt'>>(
      (id) => {
        const stored = byId.get(id);
        if (stored) return [stored];
        if (!permitted.has(id)) return [];
        return [
          {
            positionId: id,
            levelId: null,
            levelName: null,
            levelColor: settings.defaultColor as string,
            computedAt: null,
          },
        ];
      },
    );
    const projected = await projectRiskViews(bound, ctx, wanted, tx);
    projected.forEach((view, i) => {
      cards.set(wanted[i]!.positionId, {
        ...view,
        ...('computedAt' in view
          ? {
              resultAsOf: view.computedAt ? new Date(String(view.computedAt)).toISOString() : null,
            }
          : {}),
      });
    });
  }
  return cards;
}

export async function readPositionMap(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  asOf: string,
  today: string,
) {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const scope = await resolveModuleScopeInTransaction(bound, ctx, tx, codeOf('map'));
  const display = { ...ctx, scope, asOf, today };
  const ids = await readMapDisplayScope(tx, display, 'position');
  if (!ids.length) return { items: [], roots: [], asOf, hasDataPermission: scope.hasDataPermission };
  const prefs = await readPreferences(tx, ctx.tenantId, ctx.userId, 'position');
  const structure = await readPositionMapStructure(tx, display, prefs);
  const fields = await getModuleViewableFieldsInTransaction(bound, ctx, codeOf('map'), tx);
  const canView = (field: string) => fields === undefined || fields.has(field);
  const settings = await readMapTenantSettings(tx, ctx.tenantId, 'position');
  const hidden = new Set(
    rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT p.id FROM job_position_objects p
    WHERE p.tenant_id=${ctx.tenantId}::uuid AND p.id=ANY(${`{${ids.join(',')}}`}::uuid[])
    AND ${selfRecordHiddenSql(ctx, { type: sql`'position'`, org: sql`NULL`, position: sql`p.id` }, today)}`),
    ).map((p) => p.id),
  );
  const records =
    canView('successors') || canView('successorCount') ? await readMapSuccessors(tx, ctx, ids, asOf, today) : [];
  const incumbents = settings.showIncumbents ? await loadIncumbentIds(tx, ctx.tenantId, ids, asOf) : new Map();
  const people = await loadPeople(tx, ctx.tenantId, [
    ...(canView('successors') ? records.map((r) => r.employeeId) : []),
    ...[...incumbents.values()].flat(),
  ]);
  const successors = new Map<string, MapSuccessor[]>();
  for (const row of records) successors.set(row.positionId, [...(successors.get(row.positionId) ?? []), row]);
  const risk = await positionRiskCards(tx, bound, ctx, ids, today);
  const visible = new Set(ids);
  const items = ids.map((id) => {
    const position = structure.nodes.get(id)!;
    const parent = structure.parents.get(id);
    const rows = successors.get(id) ?? [];
    return {
      id,
      name: position.name,
      orgId: position.orgId,
      parentId: parent && visible.has(parent) ? parent : null,
      ...(settings.showIncumbents
        ? { incumbents: (incumbents.get(id) ?? []).flatMap((employeeId: string) => people.get(employeeId) ?? []) }
        : {}),
      ...(!hidden.has(id) && canView('successors')
        ? {
            successors: rows.map((r) => ({
              id: r.id,
              successor: people.get(r.employeeId) ?? null,
              readiness: r.readiness,
              backupType: r.backupType,
              startDate: r.startDate,
            })),
          }
        : {}),
      ...(!hidden.has(id) && canView('successorCount') ? { successorCount: rows.length } : {}),
      ...(risk.has(id) ? { risk: risk.get(id) } : {}),
    };
  });
  return {
    items,
    roots: items.filter((p) => !p.parentId).map((p) => p.id),
    asOf,
    hasDataPermission: scope.hasDataPermission,
  };
}
