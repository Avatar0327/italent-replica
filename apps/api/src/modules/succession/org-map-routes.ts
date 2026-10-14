/** C2 #7 / SC-R5～R7：仅消费 C1 显示集合；卡片递归权限投影与请求日 SELF 校验。 */
import { withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { loadOrgSnapshot, validIsoDate, type OrgRecord } from '../org/read-model.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { codeOf, successionContext, SUCCESSION_BASE } from './access.js';
import { readMapDisplayScope, resolveMapDisplayConditions } from './map-display.js';
import { mapDisplayBody, readMapTenantSettings } from './map-preferences.js';
import { loadPeople, type PersonView } from './read-sql.js';
import {
  fieldVisible,
  hiddenMapTargets,
  loadMapPositions,
  mapIncumbents,
  mapObjectAccess,
  readMapHealth,
  readMapRisk,
  readMapStats,
  readMapSuccessors,
  type CardTarget,
  type MapPosition,
} from './map-card-reader.js';

function orgMapQuery(c: Context<TenantEnv>, today: string) {
  const asOf = c.req.query('asOf') ?? today;
  if (!validIsoDate(asOf)) throw new AppError('VALIDATION_FAILED', '查询时点必须为合法日期');
  if (asOf > today) throw new AppError('VALIDATION_FAILED', '查询时点不能晚于今天', { reason: 'AS_OF_IN_FUTURE' });
  const query = c.req.query();
  if (Object.keys(query).some((key) => !['root', 'depth', 'hiddenOrgIds', 'asOf'].includes(key)))
    throw new AppError('VALIDATION_FAILED', '地图查询条件不合法');
  let hiddenOrgIds: unknown;
  try {
    hiddenOrgIds = query.hiddenOrgIds === undefined ? undefined : JSON.parse(query.hiddenOrgIds);
  } catch {
    throw new AppError('VALIDATION_FAILED', '隐藏组织必须为 JSON 数组');
  }
  const parsed = mapDisplayBody.safeParse({
    ...(query.root === undefined ? {} : { rootOrgId: query.root }),
    ...(query.depth === undefined ? {} : { depth: Number(query.depth) }),
    ...(hiddenOrgIds === undefined ? {} : { hiddenOrgIds }),
  });
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '地图查询条件不合法');
  return { asOf, supplied: parsed.data };
}
/** 只排序 C1 已选择的节点，不再解析层数、范围或隐藏规则。 */
function orderNodes(orgs: readonly OrgRecord[]) {
  const ids = new Set(orgs.map((o) => o.id));
  const children = new Map<string | null, OrgRecord[]>();
  for (const org of orgs) {
    const parent = org.parents.admin?.parentId;
    const key = parent && ids.has(parent) ? parent : null;
    const siblings = children.get(key) ?? [];
    siblings.push(org);
    children.set(key, siblings);
  }
  for (const siblings of children.values())
    siblings.sort(
      (a, b) =>
        (a.displayOrder ?? Infinity) - (b.displayOrder ?? Infinity) ||
        a.code.localeCompare(b.code) ||
        a.id.localeCompare(b.id),
    );
  const result: OrgRecord[] = [],
    seen = new Set<string>();
  const walk = (parent: string | null) => {
    for (const org of children.get(parent) ?? []) {
      if (seen.has(org.id)) continue;
      seen.add(org.id);
      result.push(org);
      walk(org.id);
    }
  };
  walk(null);
  return result;
}
function projectOrgMapCards(
  orgs: readonly OrgRecord[],
  data: {
    selected: ReadonlySet<string>;
    mapFields: ReadonlySet<string> | undefined;
    positions: readonly MapPosition[];
    heads: ReadonlyMap<string, PersonView> | null;
    incumbents: ReadonlyMap<string, readonly PersonView[]> | null;
    health: ReadonlyMap<string, object>;
    risk: ReadonlyMap<string, object>;
    stats: ReadonlyMap<string, object> | null;
    succession: (id: string) => object;
  },
) {
  const { selected, mapFields, positions, heads, incumbents, health, risk, stats, succession } = data;
  return orgs.map((org) => ({
    id: org.id,
    name: org.name,
    parentId: selected.has(org.parents.admin?.parentId ?? '') ? org.parents.admin!.parentId : null,
    ...(heads ? { personInCharge: org.personInChargeId ? (heads.get(org.personInChargeId) ?? null) : null } : {}),
    ...succession(org.id),
    ...(health.has(org.id) ? { health: health.get(org.id) } : {}),
    ...(stats ? { stats: stats.get(org.id) } : {}),
    ...(fieldVisible(mapFields, 'keyPositions')
      ? {
          keyPositions: positions
            .filter((p) => p.orgId === org.id)
            .map((p) => ({
              id: p.id,
              name: p.name,
              parentId: org.id,
              ...(incumbents ? { incumbents: incumbents.get(p.id) ?? [] } : {}),
              ...succession(p.id),
              ...(risk.has(p.id) ? { risk: risk.get(p.id) } : {}),
            })),
        }
      : {}),
  }));
}
export function registerOrgMapRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${SUCCESSION_BASE}/maps/org`, async (c) => {
    const ctx = await successionContext(c, deps, 'map');
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const { asOf, supplied } = orgMapQuery(c, today);
    const response = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
      await successionContext(c, bound, 'map');
      const scope = await resolveModuleScopeInTransaction(bound, ctx, tx, codeOf('map'), `${codeOf('map')}.list`);
      const displayCtx = { ...ctx, scope, asOf };
      const prefs = await resolveMapDisplayConditions(tx, displayCtx, 'org', supplied, 'submitted');
      const ids = await readMapDisplayScope(tx, displayCtx, 'org', supplied, 'submitted');
      const mapFields = await getModuleViewableFieldsInTransaction(bound, ctx, codeOf('map'), tx);
      const selected = new Set(ids);
      const orgs = orderNodes(
        (await loadOrgSnapshot(tx, ctx.tenantId, asOf, undefined, { scope, includeDisabled: false })).filter((o) =>
          selected.has(o.id),
        ),
      );
      const settings = await readMapTenantSettings(tx, ctx.tenantId, 'org');
      // DEC-453②：本轮固定展示关键职位，显示开关延期 F-105；仍服从 Map.keyPositions 字段权。
      const positions = fieldVisible(mapFields, 'keyPositions')
        ? await loadMapPositions(tx, ctx.tenantId, ids, scope, asOf, today)
        : [];
      const targets: CardTarget[] = [
        ...ids.map((id) => ({ id, type: 'org' as const })),
        ...positions.map(({ id }) => ({ id, type: 'position' as const })),
      ];
      const recordAccess = await mapObjectAccess(tx, bound, ctx, 'record');
      const hidden = await hiddenMapTargets(tx, ctx, targets, today);
      const successors = await readMapSuccessors(tx, bound, ctx, targets, asOf, today, recordAccess);
      const headIds = orgs.flatMap((o) => o.personInChargeId ?? []);
      const positionIds = positions.map((p) => p.id);
      const heads =
        settings.showIncumbents && recordAccess && fieldVisible(recordAccess.fields, 'personInCharge')
          ? await loadPeople(tx, ctx.tenantId, headIds)
          : null;
      const incumbents =
        settings.showIncumbents && recordAccess && fieldVisible(recordAccess.fields, 'incumbents')
          ? await mapIncumbents(tx, ctx.tenantId, positionIds, asOf)
          : null;
      const risk = await readMapRisk(tx, bound, ctx, positionIds);
      const health = await readMapHealth(tx, bound, ctx, ids, asOf);
      const stats = fieldVisible(mapFields, 'stats') ? await readMapStats(tx, ctx, scope, ids, asOf) : null;
      const succession = (id: string) =>
        hidden.has(id) || !recordAccess
          ? {}
          : {
              ...(fieldVisible(mapFields, 'successors') ? { successors: successors.get(id)?.successors ?? [] } : {}),
              ...(fieldVisible(mapFields, 'successorCount') ? { successorCount: successors.get(id)?.count ?? 0 } : {}),
            };
      return {
        asOf,
        rootId: orgs[0]?.id ?? null,
        depth: prefs.depth,
        hasDataPermission: scope.hasDataPermission,
        items: projectOrgMapCards(orgs, {
          selected,
          mapFields,
          positions,
          heads,
          incumbents,
          health,
          risk,
          stats,
          succession,
        }),
      };
    });
    return c.json(response);
  });
}
