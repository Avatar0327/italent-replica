/** C1 单一集合入口：显示端、B4 冻结和组织统计共用条件解析、当前范围与业务日。 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import { listJobObjects, type JobRecord } from '../job/read-model.js';
import { scopeAllows, type ModuleScope } from '../permission/module-access.js';
import {
  readPreferences,
  readMapTenantSettings,
  mapDisplayBody,
  preferenceBody,
  type MapKind,
  type MapPreferences,
} from './map-preferences.js';
import { selfRecordHiddenSql, rowsOf } from './read-sql.js';

export interface MapDisplayContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly asOf: string;
  /** 历史展示仍用请求日范围与 SELF；计算调用方不传时等于业务日。设计 §5.8。 */
  readonly today?: string;
  readonly scope: ModuleScope;
}
/** DEC-431①：新提交校验引用启用性；保存筛选仅应用有效隐藏项，不能用首次门槛阻断重放。 */
export type MapConditionOrigin = 'submitted' | 'saved';
export async function resolveMapDisplayConditions(
  tx: Tx,
  ctx: MapDisplayContext,
  kind: MapKind,
  supplied?: unknown,
  origin: MapConditionOrigin = 'saved',
): Promise<MapPreferences> {
  const parsed = (kind === 'org' ? mapDisplayBody : preferenceBody.partial()).safeParse(
    supplied === undefined ? {} : supplied,
  );
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '地图显示条件不合法');
  const prefs = { ...(await readPreferences(tx, ctx.tenantId, ctx.userId, kind)), ...parsed.data };
  const references = origin === 'submitted' ? [prefs.rootOrgId, ...prefs.hiddenOrgIds] : [prefs.rootOrgId];
  const ids = [...new Set(references.filter((id): id is string => !!id))];
  if (ids.length || prefs.hiddenOrgIds.length) {
    const orgs = await loadOrgSnapshot(tx, ctx.tenantId, ctx.asOf, undefined, {
      scope: ctx.scope,
      includeDisabled: false,
    });
    if (ids.some((id) => !orgs.some((o) => o.id === id))) throw new AppError('NOT_FOUND', '显示组织不存在');
    // 根必须仍有效且在当前范围，不能静默回退扩大地图；保存的隐藏项无效则忽略，不改原偏好行。
    if (origin === 'saved') prefs.hiddenOrgIds = prefs.hiddenOrgIds.filter((id) => orgs.some((o) => o.id === id));
  }
  return prefs;
}
export async function readMapDisplayScope(
  tx: Tx,
  ctx: MapDisplayContext,
  kind: MapKind,
  supplied?: unknown,
  origin: MapConditionOrigin = 'saved',
  purpose: 'display' | 'health' = 'display',
) {
  // DEC-448 / DEC-305④：共用范围与时点入口，健康度不应用地图筛选。
  if (purpose === 'health') {
    if (!ctx.scope.hasDataPermission) return [];
    return (
      await loadOrgSnapshot(tx, ctx.tenantId, ctx.asOf, undefined, { includeDisabled: false, scope: ctx.scope })
    ).map((o) => o.id);
  }
  if (!ctx.scope.hasDataPermission && origin === 'saved') return [];
  const prefs = await resolveMapDisplayConditions(tx, ctx, kind, supplied, origin);
  if (!ctx.scope.hasDataPermission) return [];
  const settings = await readMapTenantSettings(tx, ctx.tenantId, kind);
  const orgs = await loadOrgSnapshot(tx, ctx.tenantId, ctx.asOf, undefined, { includeDisabled: false });
  const byId = new Map(orgs.map((o) => [o.id, o]));
  const permitted = orgs.filter((o) => scopeAllows(ctx.scope, { orgId: o.id }));
  const hidden = new Set(prefs.hiddenOrgIds);
  const excluded = (id: string) => hidden.has(id) || (settings.hideVirtual && byId.get(id)?.isVirtual);
  // SC-R5 隐藏组织及其下级；换根不能绕过隐藏祖先，显示与冻结统一按整支子树裁剪。
  const excludedSubtree = (id: string) => {
    const seen = new Set<string>();
    while (byId.has(id) && !seen.has(id)) {
      seen.add(id);
      if (excluded(id)) return true;
      id = byId.get(id)!.parents.admin?.parentId ?? '';
    }
    return false;
  };
  let root = prefs.rootOrgId;
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
  const selected = new Set<string>(),
    visited = new Set<string>();
  const children = new Map<string, string[]>();
  for (const o of orgs) {
    const parent = o.parents.admin?.parentId;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), o.id]);
  }
  const walk = (id: string, level: number) => {
    if (visited.has(id) || excluded(id) || (kind === 'org' && level > prefs.depth)) return;
    visited.add(id);
    const visible = scopeAllows(ctx.scope, { orgId: id });
    if (visible || kind === 'position') selected.add(id);
    // §5.5 组织单根截断；§5.6 职位权限断层继续找下级，之后按职位结构建立新根。
    if (!visible && kind === 'org') return;
    for (const child of children.get(id) ?? []) walk(child, level + 1);
  };
  if (root) {
    if (!excludedSubtree(root)) walk(root, 1);
  } else
    for (const o of kind === 'position' ? orgs : permitted) {
      if (!excludedSubtree(o.id)) selected.add(o.id);
    }
  if (kind === 'org') return [...selected];
  return positionScope(tx, ctx, prefs, selected);
}
export async function mapPositions(tx: Tx, tenantId: string, asOf: string, scope?: ModuleScope) {
  const positions: JobRecord[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await listJobObjects(tx, tenantId, 'positions', { asOf, scope, limit: 200, offset });
    positions.push(...page);
    if (page.length < 200) break;
  }
  return positions;
}
/** 结构只依赖历史版本与关键职位筛选；C1 集合与 C3 连边共用，权限断层由调用方裁成新根。 */
export async function readPositionMapStructure(tx: Tx, ctx: MapDisplayContext, prefs: MapPreferences) {
  const positions = await mapPositions(tx, ctx.tenantId, ctx.asOf);
  const byId = new Map(positions.map((p) => [p.id, p]));
  // Q-M0-177 / DEC-443：先建与查看人无关的结构父节点，跳过停用及被筛掉的非关键职位。
  const nodes = new Map(
    positions.filter((p) => p.enabled && (!prefs.showKeyPositions || p.isKey)).map((p) => [p.id, p]),
  );
  const structuralParent = (id: string) => {
    let p = byId.get(id)?.directParentId;
    const seen = new Set([id]);
    while (p && !seen.has(p)) {
      if (nodes.has(p)) return p;
      seen.add(p);
      p = byId.get(p)?.directParentId;
    }
    return null;
  };
  return { nodes, parents: new Map([...nodes.keys()].map((id) => [id, structuralParent(id)])) };
}
async function positionScope(tx: Tx, ctx: MapDisplayContext, prefs: MapPreferences, selected: ReadonlySet<string>) {
  const structure = await readPositionMapStructure(tx, ctx, prefs);
  // DEC-368① / 设计 §5.8：历史职位的展示归属取 asOf，准入按请求日所属组织在 SQL 中裁剪。
  const allowed = new Set(
    (await mapPositions(tx, ctx.tenantId, ctx.today ?? ctx.asOf, ctx.scope))
      .filter((p) => scopeAllows(ctx.scope, { orgId: p.orgId }))
      .map((p) => p.id),
  );
  const ids = new Set(
    [...structure.nodes.values()].filter((p) => p.orgId && selected.has(p.orgId) && allowed.has(p.id)).map((p) => p.id),
  );
  const parents = new Map<string, string | null>(),
    children = new Map<string, string[]>();
  for (const id of ids) {
    const parent = structure.parents.get(id);
    // §5.6：结构父节点不可见即新根，不向上越过权限断层寻找更远可见祖先。
    const visibleParent = parent && ids.has(parent) ? parent : null;
    parents.set(id, visibleParent);
    if (visibleParent) children.set(visibleParent, [...(children.get(visibleParent) ?? []), id]);
  }
  const retained = prefs.showPositionsWithoutSuccessor ? ids : new Set<string>();
  if (!prefs.showPositionsWithoutSuccessor) {
    const active = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT DISTINCT r.target_position_id AS id
      FROM succession_records r WHERE r.tenant_id=${ctx.tenantId}::uuid AND r.succession_type='position'
      AND r.deleted_at IS NULL AND r.start_date<=${ctx.asOf}::date AND r.end_date>${ctx.asOf}::date
      AND NOT ${selfRecordHiddenSql(
        ctx,
        { type: sql`r.succession_type`, org: sql`r.target_org_id`, position: sql`r.target_position_id` },
        ctx.today ?? ctx.asOf,
      )}`),
    );
    for (const { id } of active) {
      let p: string | null = id;
      while (p && ids.has(p) && !retained.has(p)) {
        retained.add(p);
        p = parents.get(p) ?? null;
      }
    }
  }
  // P2-1：有继任者子树判定后按可见职位根计层；组织深度、跳过节点均不消耗职位层数。
  const displayed = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (displayed.has(id) || depth > prefs.depth || !retained.has(id)) return;
    displayed.add(id);
    for (const child of children.get(id) ?? []) walk(child, depth + 1);
  };
  for (const [id, parent] of parents) if (!parent) walk(id, 1);
  return [...displayed];
}
