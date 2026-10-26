/** DEC-691：业务日关系取人；实时资格复核后交既有路由，来源层不做人数截断。 */
import { sql, type Tx } from '@italent/db';
import { relationSource, type ApproverSource, type Candidate } from '@italent/domain';
import { findCurrentRecord } from '../employment/read-model.js';
import { loadJobObject } from '../job/read-model.js';
import { eligibleDesignerPeople } from './designer-people.js';
import { rowsOf } from './context.js';
import { candidateOf, memo, type RoutingSubject } from './resolver.js';
import { dimensionEnabled, orgReferenceRows } from './source-reference.js';

type Reference = NonNullable<ReturnType<typeof relationSource>>;
interface OrgLink {
  id: string;
  parent_id: string | null;
  head_id: string | null;
  enabled: boolean;
  seed: boolean;
}

/** 有限集合 UNION 消除环：先找所选子树，再补足各分支的祖先，不读取其它维度或其它租户。 */
async function orgGraph(
  tx: Tx,
  subject: RoutingSubject,
  root: string,
  dimension: 'admin' | 'business' | 'product' | 'reserve4' | 'reserve5',
  descendants: boolean,
) {
  return rowsOf<OrgLink>(
    await tx.execute(sql`WITH RECURSIVE graph AS (
      ${orgReferenceRows(subject.tenantId, subject.businessDate!, dimension)}
    ), seeds(id) AS (
      SELECT id FROM graph WHERE id=${root}::uuid
      UNION SELECT g.id FROM graph g JOIN seeds s ON g.parent_id=s.id WHERE ${descendants}
    ), ancestors(id) AS (
      SELECT id FROM seeds UNION SELECT g.parent_id FROM graph g JOIN ancestors a ON g.id=a.id
      WHERE g.parent_id IS NOT NULL
    ) SELECT g.*, EXISTS(SELECT 1 FROM seeds s WHERE s.id=g.id) AS seed
      FROM graph g JOIN ancestors a ON a.id=g.id ORDER BY g.id`),
  );
}
function* ancestors(graph: Map<string, OrgLink>, start: string) {
  const seen = new Set<string>();
  let id: string | null = start;
  while (id && !seen.has(id)) {
    seen.add(id);
    const node: OrgLink | undefined = graph.get(id);
    if (!node) return;
    yield node;
    id = node.parent_id;
  }
}
/** 共用 F-304 在职内部账号判定与 F-318a 派单闸；不改变旧固定表达式资格语义。 */
async function eligiblePerson(tx: Tx, subject: RoutingSubject, personId: string | null): Promise<Candidate | null> {
  if (!personId) return null;
  return memo(subject, `source-person:${personId}`, async () => {
    const candidate = await candidateOf(tx, subject, personId);
    if (!candidate.userId) return null;
    const people = await eligibleDesignerPeople(tx, subject.tenantId, {
      userIds: [candidate.userId],
      limit: 1,
      offset: 0,
      asOf: subject.asOf,
    });
    return people.length ? candidate : null;
  });
}
async function organization(tx: Tx, subject: RoutingSubject, ref: Reference): Promise<Candidate[]> {
  if (!(await dimensionEnabled(tx, subject.tenantId, ref.dimension))) return [];
  const links = await orgGraph(tx, subject, ref.id, ref.dimension!, ref.mode === 'descendants');
  const graph = new Map(links.map((node) => [node.id, node]));
  const found = new Map<string, Candidate>();
  for (const start of links.filter((node) => node.seed)) {
    for (const node of ancestors(graph, start.id)) {
      const candidate = node.enabled ? await eligiblePerson(tx, subject, node.head_id) : null;
      if (!candidate?.userId) continue;
      found.set(candidate.userId, candidate);
      break;
    }
  }
  return [...found.values()];
}

/** 主职时间轴 + 最新不可变快照；兼职不在该时间轴中，也显式限定 primary，清空值不得回退旧列。 */
async function jobPeople(tx: Tx, subject: RoutingSubject, ref: Reference) {
  const column = ref.type === 'position' ? sql`'position_id'` : sql`'post_id'`;
  return rowsOf<{ employee_id: string; department_id: string | null }>(
    await tx.execute(sql`
    SELECT r.employee_id,(CASE WHEN p.body IS NULL THEN r.department_id::text
      ELSE p.body->>'department_id' END)::uuid AS department_id
    FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    LEFT JOIN LATERAL (SELECT to_jsonb(v) AS body FROM employment_payload_versions v
      WHERE v.tenant_id=r.tenant_id AND v.business_id=r.id AND v.employee_id=r.employee_id AND v.is_record_snapshot
      ORDER BY v.version_no DESC LIMIT 1) p ON true
    WHERE t.tenant_id=${subject.tenantId} AND t.valid_during @> ${subject.businessDate}::date
      AND r.service_type='primary' AND r.kind NOT IN ('leave','retirement')
      AND (CASE WHEN p.body IS NULL THEN to_jsonb(r) ELSE p.body END)->>${column}=${ref.id}
    ORDER BY r.employee_id`),
  );
}
async function jobHolders(tx: Tx, subject: RoutingSubject, ref: Reference): Promise<Candidate[]> {
  const object = await loadJobObject(
    tx,
    subject.tenantId,
    ref.type === 'position' ? 'positions' : 'posts',
    ref.id,
    subject.businessDate!,
  );
  if (!object) return [];
  const people = await jobPeople(tx, subject, ref);
  const found: Candidate[] = [];
  if (ref.mode !== 'relative') {
    for (const person of people) {
      const candidate = await eligiblePerson(tx, subject, person.employee_id);
      if (candidate) found.push(candidate);
    }
    return found;
  }
  if (!subject.subjectEmployeeId) return [];
  const record = await findCurrentRecord(tx, subject.tenantId, subject.subjectEmployeeId, subject.businessDate!);
  if (!record?.fields.departmentId) return [];
  const links = await orgGraph(tx, subject, record.fields.departmentId, 'admin', false);
  const graph = new Map(links.map((node) => [node.id, node]));
  for (const node of ancestors(graph, record.fields.departmentId)) {
    if (!node.enabled) continue;
    for (const person of people.filter((person) => person.department_id === node.id)) {
      const candidate = await eligiblePerson(tx, subject, person.employee_id);
      if (candidate) found.push(candidate);
    }
    if (found.length) return found;
  }
  return [];
}
export async function resolveRelation(tx: Tx, subject: RoutingSubject, source: ApproverSource): Promise<Candidate[]> {
  const ref = relationSource(source);
  if (!ref || !subject.businessDate) return [];
  return ref.dimension ? organization(tx, subject, ref) : jobHolders(tx, subject, ref);
}
