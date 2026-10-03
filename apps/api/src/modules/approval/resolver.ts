/**
 * 审批人表达式解析（REQ-APV-002 R2/R3）：调出 / 调入的区分靠“从哪条任职记录取部门”；
 * 组织的负责人、HRBP 是结构化人员引用（REQ-ORG-001 R4），人员再经账号绑定落到可审批的用户。
 */
import { sql, type Tx } from '@italent/db';
import type { ApproverExpression, Candidate } from '@italent/domain';
import { findCurrentRecord } from '../employment/read-model.js';
import { rowsOf } from './context.js';

export interface RoutingSubject {
  readonly tenantId: string;
  readonly asOf: string;
  readonly initiatorUserId: string;
  readonly latestDepartmentId: string | null;
  readonly recordDepartmentId: string | null;
}

const NOBODY: Candidate = { personId: null, userId: null };

/**
 * 账号绑定（Q-M0-30：用户与人员由管理员显式绑定）且成员关系有效，才视为可审批的人。
 * TODO(需取证 Q-M0-44)：解析到没有账号或账号停用的人员时原站如何处理未取证；首版视为审批人为空。
 */
export async function userOfPerson(tx: Tx, tenantId: string, personId: string | null): Promise<string | null> {
  if (!personId) return null;
  const [row] = rowsOf<{ user_id: string }>(
    await tx.execute(sql`SELECT l.user_id FROM permission_user_person_links l
      JOIN tenant_memberships m ON m.tenant_id=l.tenant_id AND m.user_id=l.user_id AND m.status='active'
      WHERE l.tenant_id=${tenantId} AND l.employee_id=${personId}::uuid LIMIT 1`),
  );
  return row?.user_id ?? null;
}

export async function personOfUser(tx: Tx, tenantId: string, userId: string): Promise<string | null> {
  const [row] = rowsOf<{ employee_id: string }>(
    await tx.execute(sql`SELECT employee_id FROM permission_user_person_links
      WHERE tenant_id=${tenantId} AND user_id=${userId}::uuid LIMIT 1`),
  );
  return row?.employee_id ?? null;
}

async function candidateOf(tx: Tx, tenantId: string, personId: string | null): Promise<Candidate> {
  return personId ? { personId, userId: await userOfPerson(tx, tenantId, personId) } : NOBODY;
}

/** 组织在业务日期的现行版本上的负责人 / HRBP（人员 ID）。 */
async function orgRole(tx: Tx, subject: RoutingSubject, orgId: string | null, role: 'head' | 'hrbp') {
  if (!orgId) return null;
  const [row] = rowsOf<{ person_in_charge_id: string | null; hrbp_id: string | null }>(
    await tx.execute(sql`SELECT person_in_charge_id,hrbp_id FROM org_versions
      WHERE tenant_id=${subject.tenantId} AND org_id=${orgId}::uuid AND start_date<=${subject.asOf}::date
      ORDER BY start_date DESC,version_no DESC LIMIT 1`),
  );
  return (role === 'head' ? row?.person_in_charge_id : row?.hrbp_id) ?? null;
}

/** 行政维度祖先链（含自身，自下而上，止于租户根）；深度有界，防环。 */
export async function adminAncestors(tx: Tx, tenantId: string, asOf: string, orgId: string): Promise<string[]> {
  const rows = rowsOf<{ org_id: string }>(
    await tx.execute(sql`WITH RECURSIVE chain(org_id,depth,path) AS (
        SELECT ${orgId}::uuid,0,ARRAY[${orgId}::uuid]
        UNION ALL
        SELECT h.parent_org_id,c.depth+1,c.path||h.parent_org_id FROM chain c
        JOIN LATERAL (SELECT id FROM org_versions v WHERE v.tenant_id=${tenantId} AND v.org_id=c.org_id
          AND v.start_date<=${asOf}::date ORDER BY v.start_date DESC,v.version_no DESC LIMIT 1) cur ON true
        JOIN org_hierarchy_links h ON h.tenant_id=${tenantId} AND h.version_id=cur.id AND h.dimension='admin'
        WHERE h.parent_org_id IS NOT NULL AND c.depth<100 AND NOT h.parent_org_id=ANY(c.path)
      ) SELECT org_id FROM chain ORDER BY depth`),
  );
  return rows.map((row) => row.org_id);
}

/** 一级组织 = 租户根的直接下级（`14` §2.1 FirstLevelOrganization）。 */
async function firstLevelOrg(tx: Tx, subject: RoutingSubject, orgId: string | null): Promise<string | null> {
  if (!orgId || orgId === subject.tenantId) return null;
  const chain = await adminAncestors(tx, subject.tenantId, subject.asOf, orgId);
  const rootIndex = chain.indexOf(subject.tenantId);
  return rootIndex > 0 ? chain[rootIndex - 1]! : null;
}

export async function resolveCandidate(
  tx: Tx,
  subject: RoutingSubject,
  expression: ApproverExpression,
): Promise<Candidate> {
  const { tenantId } = subject;
  switch (expression) {
    case 'owner':
      return { personId: await personOfUser(tx, tenantId, subject.initiatorUserId), userId: subject.initiatorUserId };
    case 'latest_record_department_head':
      return candidateOf(tx, tenantId, await orgRole(tx, subject, subject.latestDepartmentId, 'head'));
    case 'record_department_head':
      return candidateOf(tx, tenantId, await orgRole(tx, subject, subject.recordDepartmentId, 'head'));
    case 'record_department_hrbp':
      return candidateOf(tx, tenantId, await orgRole(tx, subject, subject.recordDepartmentId, 'hrbp'));
    case 'record_first_level_org_head': {
      const firstLevel = await firstLevelOrg(tx, subject, subject.recordDepartmentId);
      return candidateOf(tx, tenantId, await orgRole(tx, subject, firstLevel, 'head'));
    }
  }
}

/** DEC-068：自审时转该审批人任职记录上的直线经理。 */
export async function directManagerOf(tx: Tx, subject: RoutingSubject, candidate: Candidate): Promise<Candidate> {
  const personId =
    candidate.personId ?? (candidate.userId ? await personOfUser(tx, subject.tenantId, candidate.userId) : null);
  if (!personId) return NOBODY;
  const record = await findCurrentRecord(tx, subject.tenantId, personId, subject.asOf);
  return candidateOf(tx, subject.tenantId, record?.fields.directManagerId ?? null);
}
