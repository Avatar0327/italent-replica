/** C1 可信读函数：调用方每次解析当前 Map 范围，传入请求日权限及业务日；空范围不兜底全部。 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import { listJobObjects, type JobRecord } from '../job/read-model.js';
import { scopeAllows, type ModuleScope } from '../permission/module-access.js';
import { readPreferences, readMapTenantSettings, type MapKind, type MapPreferences } from './map-preferences.js';
import { selfRecordHiddenSql, rowsOf } from './read-sql.js';

export interface MapDisplayContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly asOf: string;
  readonly scope: ModuleScope;
}
export async function readMapDisplayScope(tx: Tx, ctx: MapDisplayContext, kind: MapKind, supplied?: MapPreferences) {
  if (!ctx.scope.hasDataPermission) return [];
  const prefs = supplied ?? (await readPreferences(tx, ctx.tenantId, ctx.userId, kind));
  const settings = await readMapTenantSettings(tx, ctx.tenantId, kind);
  const orgs = await loadOrgSnapshot(tx, ctx.tenantId, ctx.asOf, undefined, { includeDisabled: false });
  const byId = new Map(orgs.map((o) => [o.id, o]));
  const permitted = orgs.filter((o) => scopeAllows(ctx.scope, { orgId: o.id }));
  const hidden = new Set(prefs.hiddenOrgIds);
  const excluded = (id: string) => hidden.has(id) || (settings.hideVirtual && byId.get(id)?.isVirtual);
  let root = prefs.rootOrgId;
  if (root && !permitted.some((o) => o.id === root)) throw new AppError('NOT_FOUND', '地图根组织不存在');
  if (!root && kind === 'org') {
    const depth = (id: string) => {
      const seen = new Set<string>();
      while (byId.has(id) && !seen.has(id)) {
        seen.add(id);
        id = byId.get(id)!.parents.admin?.parentId ?? '';
      }
      return seen.size;
    };
    root =
      permitted.sort(
        (a, b) =>
          depth(a.id) - depth(b.id) ||
          (a.parents.admin?.sequence ?? a.displayOrder ?? Infinity) -
            (b.parents.admin?.sequence ?? b.displayOrder ?? Infinity) ||
          a.id.localeCompare(b.id),
      )[0]?.id ?? null;
  }
  const selected = new Set<string>();
  const walk = (id: string, level: number) => {
    if (selected.has(id) || level > prefs.depth || excluded(id) || !scopeAllows(ctx.scope, { orgId: id })) return;
    selected.add(id);
    for (const o of orgs) if (o.parents.admin?.parentId === id) walk(o.id, level + 1);
  };
  if (root) walk(root, 1);
  else
    for (const o of permitted) {
      let id = o.id,
        blocked = false;
      const seen = new Set<string>();
      while (byId.has(id) && !seen.has(id)) {
        seen.add(id);
        if (excluded(id)) blocked = true;
        id = byId.get(id)!.parents.admin?.parentId ?? '';
      }
      if (!blocked) selected.add(o.id);
    }
  if (kind === 'org') return [...selected];
  return positionScope(tx, ctx, prefs, selected);
}
async function positionScope(tx: Tx, ctx: MapDisplayContext, prefs: MapPreferences, selected: ReadonlySet<string>) {
  const positions: JobRecord[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await listJobObjects(tx, ctx.tenantId, 'positions', {
      asOf: ctx.asOf,
      limit: 200,
      offset,
    });
    positions.push(...page);
    if (page.length < 200) break;
  }
  // Q-M0-177 / DEC-443：默认不按关键职位过滤，打开个人筛选才跳过非关键祖先。
  const nodes = new Map(
    positions.filter((p) => p.enabled && (!prefs.showKeyPositions || p.isKey)).map((p) => [p.id, p]),
  );
  const parent = (id: string) => {
    let p = positions.find((v) => v.id === id)?.directParentId;
    const seen = new Set([id]);
    while (p && !seen.has(p)) {
      if (nodes.has(p)) return p;
      seen.add(p);
      p = positions.find((v) => v.id === p)?.directParentId;
    }
    return null;
  };
  const visible = [...nodes.values()].filter((p) => p.orgId && selected.has(p.orgId));
  const ids = new Set(visible.map((p) => p.id));
  if (prefs.showPositionsWithoutSuccessor) return [...ids];
  const active = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT DISTINCT r.target_position_id AS id
    FROM succession_records r WHERE r.tenant_id=${ctx.tenantId}::uuid AND r.succession_type='position'
    AND r.deleted_at IS NULL AND r.start_date<=${ctx.asOf}::date AND r.end_date>${ctx.asOf}::date
    AND NOT ${selfRecordHiddenSql(
      ctx,
      { type: sql`r.succession_type`, org: sql`r.target_org_id`, position: sql`r.target_position_id` },
      ctx.asOf,
    )}`),
  );
  const retained = new Set<string>();
  for (const { id } of active) {
    let p: string | null = id;
    while (p && ids.has(p) && !retained.has(p)) {
      retained.add(p);
      p = parent(p);
    }
  }
  return [...retained];
}
