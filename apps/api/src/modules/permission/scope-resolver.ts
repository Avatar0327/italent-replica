import { PERSONNEL_SCOPE_FIELDS } from '@italent/domain';
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { expandScopeRoots, scopeRows, type ScopeRoot } from './scope-hierarchy.js';
import { EMPTY_SCOPE, type ModuleScope, type ScopeQuery, type ScopeTerm } from './scope-types.js';

const MAX_SCOPE_IDS = 20_000;
const MAX_SCOPE_RULES = 20;

async function identityAll(tx: Tx, q: ScopeQuery): Promise<boolean> {
  const rows = scopeRows(
    await tx.execute(sql`
    SELECT 1 FROM permission_identity_scopes d
    JOIN permission_grants g ON g.tenant_id=d.tenant_id AND g.profile_id=d.profile_id
      AND g.user_id=${q.userId} AND g.status='active'
    JOIN permission_profile_apps a ON a.tenant_id=g.tenant_id AND a.profile_id=g.profile_id AND a.app_code=d.app_code
    WHERE d.tenant_id=${q.tenantId} AND d.app_code=${q.appCode} AND d.see_all AND
      (d.target_kind='app' OR (d.target_kind='entity' AND d.target_code=${q.objectCode ?? ''})
        OR (d.target_kind='page' AND d.target_code=${q.pageCode ?? ''})
        OR (d.target_kind='datasource' AND d.target_code=${q.dataSourceCode ?? ''})) LIMIT 1
  `),
  );
  return rows.length > 0;
}
async function linkedPerson(tx: Tx, q: ScopeQuery): Promise<string | undefined> {
  const [row] = scopeRows<{ employee_id: string }>(
    await tx.execute(sql`
    SELECT employee_id FROM permission_user_person_links WHERE tenant_id=${q.tenantId} AND user_id=${q.userId} LIMIT 1
  `),
  );
  return row?.employee_id;
}
async function roleRoots(tx: Tx, q: ScopeQuery, roles: readonly string[], expand: boolean): Promise<ScopeRoot[]> {
  const person = await linkedPerson(tx, q);
  if (!person || !roles.length) return [];
  // TODO(需取证 Q-M0-30): user/person 由管理员显式绑定，绝不假定两者 UUID 相同。
  return scopeRows<{ org_id: string }>(
    await tx.execute(sql`
    SELECT org_id FROM (SELECT DISTINCT ON (org_id) org_id,enabled,stop_date,person_in_charge_id,hrbp_id
      FROM org_versions WHERE tenant_id=${q.tenantId} AND start_date<=${q.asOf}::date
      ORDER BY org_id,start_date DESC,version_no DESC) v WHERE enabled AND stop_date>=${q.asOf}::date
      AND ((${roles.includes('head')} AND person_in_charge_id=${person}::uuid)
        OR (${roles.includes('hrbp')} AND hrbp_id=${person}::uuid)) LIMIT 201
  `),
  ).map((row) => ({ orgId: row.org_id, dimension: 'admin', includeDescendants: expand }));
}
async function managementRoots(tx: Tx, q: ScopeQuery): Promise<ScopeRoot[]> {
  const [scope] = scopeRows<{ kind: string; mou_id: string | null }>(
    await tx.execute(sql`
    SELECT kind,mou_id FROM permission_user_app_scopes WHERE tenant_id=${q.tenantId}
      AND user_id=${q.userId} AND app_code=${q.appCode} LIMIT 1
  `),
  );
  if (scope && scope.kind !== 'default') {
    return scopeRows<{ org_id: string; dimension: string; include_descendants: boolean }>(
      await tx.execute(sql`
      SELECT r.org_id,r.dimension,r.include_descendants FROM permission_mou_org_refs r
      JOIN permission_mous m ON m.tenant_id=r.tenant_id AND m.id=r.mou_id
      WHERE r.tenant_id=${q.tenantId} AND r.mou_id=${scope.mou_id} AND m.status='active' LIMIT 201
    `),
    ).map((r) => ({ orgId: r.org_id, dimension: r.dimension, includeDescendants: r.include_descendants }));
  }
  // TODO(需取证 Q-M0-34): 动态组织角色暂只覆盖角色所在组织本级，不隐式包含下级。
  // REQ-PRM-002: org-role automatic grant + default MOU + HR/attendance is an explicit branch.
  const roles = scopeRows<{ role_code: string }>(
    await tx.execute(sql`
    SELECT DISTINCT d.role_code FROM permission_dynamic_org_grants d
    JOIN permission_grants g ON g.tenant_id=d.tenant_id AND g.id=d.grant_id AND g.source='auto'
      AND g.status='active' AND g.user_id=${q.userId}
    JOIN permission_profile_apps a ON a.tenant_id=g.tenant_id AND a.profile_id=g.profile_id AND a.app_code=${q.appCode}
    LEFT JOIN permission_scope_apps m ON m.tenant_id=g.tenant_id AND m.app_code=a.app_code
    WHERE d.tenant_id=${q.tenantId} AND COALESCE(m.family,CASE WHEN a.app_code='TenantBase' THEN 'hr' ELSE 'other' END)
      IN ('hr','attendance') LIMIT 200
  `),
  );
  return roleRoots(
    tx,
    q,
    roles.map((row) => row.role_code),
    false,
  );
}
interface Rule {
  dimension: ScopeTerm['dimension'];
  role_code: string | null;
  relation_mode: string | null;
}
async function rulesFor(tx: Tx, q: ScopeQuery): Promise<{ source: ModuleScope['source']; rules: Rule[] }> {
  const policies = scopeRows<{ id: string; target_kind: 'entity' | 'page' | 'datasource' }>(
    await tx.execute(sql`
    SELECT id,target_kind FROM permission_scope_policies WHERE tenant_id=${q.tenantId}
      AND app_code=${q.appCode} AND object_code=${q.objectCode ?? ''} AND
      ((target_kind='entity' AND target_code=${q.objectCode ?? ''})
        OR (target_kind='page' AND target_code=${q.pageCode ?? ''})
        OR (target_kind='datasource' AND target_code=${q.dataSourceCode ?? ''}))
    LIMIT 3
  `),
  );
  // TODO(需取证 Q-M0-32): §13.1 未定义页面与数据源之间的优先级，不得任意选一或合并范围。
  const specific = policies.filter((policy) => policy.target_kind !== 'entity');
  if (specific.length > 1) throw new AppError('SERVICE_UNAVAILABLE', '页面与数据源数据权限冲突，需核实配置');
  const policy = specific[0] ?? policies.find((candidate) => candidate.target_kind === 'entity');
  // TODO(需取证 Q-M0-32): 未配置实体策略时暂按管理单元规则 fail-closed 解析。
  if (!policy) return { source: 'entity', rules: [{ dimension: 'management', role_code: null, relation_mode: null }] };
  const rules = scopeRows<Rule>(
    await tx.execute(sql`
    SELECT dimension,role_code,relation_mode FROM permission_scope_policy_rules
    WHERE tenant_id=${q.tenantId} AND policy_id=${policy.id} ORDER BY id LIMIT ${MAX_SCOPE_RULES + 1}
  `),
  );
  if (rules.length > MAX_SCOPE_RULES) throw new AppError('PAYLOAD_TOO_LARGE', '数据范围策略最多 20 条规则');
  return { source: policy.target_kind, rules };
}

function ruleKey(rule: Rule): string {
  if (rule.dimension === 'organization') return `organization:${rule.role_code ?? ''}`;
  if (rule.dimension === 'reporting') return `reporting:${rule.relation_mode ?? 'direct'}`;
  return rule.dimension;
}

function addBoundedIds(target: Set<string>, ids: readonly string[]): void {
  for (const id of ids) {
    target.add(id);
    if (target.size > MAX_SCOPE_IDS) throw new AppError('PAYLOAD_TOO_LARGE', '数据范围并集超过有界解析上限');
  }
}

/** Single resolver behind the authorizer; a trusted asOf, never approval participation. */
export async function resolveDataScope(tx: Tx, query: ScopeQuery): Promise<ModuleScope> {
  if (await identityAll(tx, query)) return { ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' };
  const { source, rules } = await rulesFor(tx, query);
  const terms: ScopeTerm[] = [];
  const usesPersonnelScope = [
    'TenantBase.Employee',
    'TenantBase.EmploymentRecord',
    ...Object.keys(PERSONNEL_SCOPE_FIELDS),
  ].includes(query.objectCode ?? '');
  const orgIds = new Set<string>();
  const resolvedRules = new Set<string>();
  for (const rule of rules) {
    // Identical OR rules do not widen access; derive once instead of repeating the query and SQL predicate.
    const key = ruleKey(rule);
    if (resolvedRules.has(key)) continue;
    resolvedRules.add(key);
    let term: ScopeTerm | undefined;
    if (rule.dimension === 'management') {
      const roots = await managementRoots(tx, query);
      const orgIds = await expandScopeRoots(tx, query.tenantId, query.asOf, roots);
      term = {
        dimension: 'management',
        orgIds,
        personIds: [],
        ...(usesPersonnelScope && orgIds.length
          ? { personQuery: { kind: 'organization' as const, tenantId: query.tenantId, asOf: query.asOf } }
          : {}),
      };
    } else if (rule.dimension === 'organization') {
      const roots = await roleRoots(tx, query, [rule.role_code ?? ''], true);
      const orgIds = await expandScopeRoots(tx, query.tenantId, query.asOf, roots);
      term = {
        dimension: 'organization',
        orgIds,
        personIds: [],
        ...(usesPersonnelScope && orgIds.length
          ? { personQuery: { kind: 'organization' as const, tenantId: query.tenantId, asOf: query.asOf } }
          : {}),
      };
    } else if (rule.dimension === 'reporting') {
      const person = usesPersonnelScope ? await linkedPerson(tx, query) : undefined;
      term = {
        dimension: 'reporting',
        orgIds: [],
        personIds: [],
        ...(usesPersonnelScope && person
          ? {
              personQuery: {
                kind: 'reporting' as const,
                tenantId: query.tenantId,
                asOf: query.asOf,
                managerId: person,
                mode: rule.relation_mode ?? 'direct',
              },
            }
          : {}),
      };
    } else if (rule.dimension === 'using_user') {
      term = { dimension: 'using_user', creatorId: query.userId, orgIds: [], personIds: [] };
    }
    if (term) {
      // Reader limits apply to one rule. Bound each distinct final union too, without counting overlaps twice.
      addBoundedIds(orgIds, term.orgIds);
      terms.push(term);
    }
  }
  return {
    orgIds: [...orgIds],
    personIds: [],
    terms,
    source,
    all: false,
    hasDataPermission: terms.some(
      (term) => !!term.creatorId || term.orgIds.length > 0 || term.personIds.length > 0 || !!term.personQuery,
    ),
  };
}
/** No scripts executed in R1; extension point reserved for future data-permission triggers. */
export interface DataScopeExtension {
  resolve(query: ScopeQuery, current: ModuleScope): Promise<ModuleScope>;
}
// TODO(R1-T07): approval detail intersects node form/viewable fields, never widens resolveDataScope (DEC-057).

/** DEC-082 personnel catalog hook: creator rights do not authorize creating a record outside managed persons. */
export async function personnelCreationScope(tx: Tx, query: ScopeQuery, current: ModuleScope): Promise<ModuleScope> {
  if (current.all || !current.terms?.some((term) => term.dimension === 'using_user')) return current;
  const orgIds = await expandScopeRoots(tx, query.tenantId, query.asOf, await managementRoots(tx, query));
  const managed: ScopeTerm = {
    dimension: 'management',
    orgIds,
    personIds: [],
    personQuery: { kind: 'organization', tenantId: query.tenantId, asOf: query.asOf },
  };
  return { ...current, terms: current.terms.map((term) => (term.dimension === 'using_user' ? managed : term)) };
}
