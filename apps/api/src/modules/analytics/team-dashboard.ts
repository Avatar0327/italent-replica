/**
 * 团队人事看板的范围（docs/02_业务建模/35 §2.1b、AC-HA-06，DEC-763③）：
 * 本人 + 本人负责部门（含下级部门，asOf 当天的行政维度）里的在职人员 + 经主职直线经理一路往下的汇报链（含隔级）。
 * 不含虚线下属，离职人员不在在职行集里。范围只由“调用者是谁”算出，与角色的数据范围（管理单元 / 看全部）无关——
 * 人事管理员兼部门负责人时团队看板也不会被角色范围放大（原站 A2：报表 311 人、团队看板 8 人）。
 * 看板数字与钻取明细都从同一个谓词取行（hr-structure.ts structurePeopleWhere），所以数字 = 明细。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { managerIdentity } from '../permission/manager-identity.js';
import { MAX_SCOPE_IDS, scopeRows } from '../permission/scope-hierarchy.js';
import { currentPersons } from '../permission/scope-persons.js';

export interface TeamViewer {
  readonly tenantId: string;
  readonly userId: string;
  readonly asOf: string;
}
/** 候选行（别名 m，带 employee_id / org_id）的可见谓词。 */
export interface TeamVisibility {
  readonly visible: SQL;
}

/**
 * 调用者负责的部门及其全部下级（行政维度）。根集合直接在 SQL 里由“负责人 = 调用者”产生，不经“范围根最多 200 条”
 * 的入参上限（那是给调用方手填的范围根设的），所以负责部门再多也不会被整体拒绝；展开结果仍受 20,000 个组织的
 * 有界上限，超限整体 413，绝不截断后返回部分数据。停用的下级组织照旧留在范围内（DEC-146）。
 */
async function ledOrgIds(tx: Tx, tenantId: string, asOf: string, leaderId: string): Promise<string[]> {
  const rows = scopeRows<{ org_id: string }>(
    await tx.execute(sql`
      WITH RECURSIVE current_versions AS (
        SELECT DISTINCT ON (org_id) id,org_id,enabled,person_in_charge_id FROM org_versions
        WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date
        ORDER BY org_id,start_date DESC,version_no DESC
      ), tree(org_id) AS (
        SELECT org_id FROM current_versions WHERE enabled AND person_in_charge_id=${leaderId}::uuid
        UNION
        SELECT v.org_id FROM tree
        JOIN org_hierarchy_links h ON h.tenant_id=${tenantId} AND h.dimension='admin' AND h.parent_org_id=tree.org_id
        JOIN current_versions v ON v.id=h.version_id
      ) SELECT org_id FROM tree LIMIT ${MAX_SCOPE_IDS + 1}
    `),
  );
  if (rows.length > MAX_SCOPE_IDS) throw new AppError('PAYLOAD_TOO_LARGE', '数据范围超过有界解析上限');
  return rows.map((row) => row.org_id);
}

/**
 * 主职直线汇报链（含隔级）。已离职 / 退休的中间经理只作穿越——仍指向他的在职下属还在上级的链里——
 * 但不进结果；虚线不走（与 reportingPersonsSql 的 all_direct 不同，那里遇到离职节点就断链）。
 */
function chainSql(tenantId: string, asOf: string, self: string, person: SQL): SQL {
  return sql`${person} IN (WITH RECURSIVE people AS (${currentPersons(tenantId, asOf)}),
    chain(employee_id) AS (
      SELECT employee_id FROM people WHERE direct_manager_id=${self}::uuid AND employee_id<>${self}::uuid
      UNION
      SELECT p.employee_id FROM people p JOIN chain c ON p.direct_manager_id=c.employee_id
      WHERE p.employee_id<>${self}::uuid
    ) SELECT c.employee_id FROM chain c JOIN people p ON p.employee_id=c.employee_id
      WHERE p.kind NOT IN ('leave','retirement'))`;
}

/** 调用者没有绑定人员档案（如外部用户）时返回 null：由接口层按“不存在”拒绝，不暴露存在性（硬规则 1，fail-closed）。 */
export async function teamVisibility(tx: Tx, viewer: TeamViewer): Promise<TeamVisibility | null> {
  const self = (await managerIdentity(tx, viewer)).employeeId;
  if (!self) return null;
  const led = `{${(await ledOrgIds(tx, viewer.tenantId, viewer.asOf, self)).join(',')}}`;
  return {
    visible: sql`(m.employee_id=${self}::uuid OR m.org_id=ANY(${led}::uuid[])
      OR ${chainSql(viewer.tenantId, viewer.asOf, self, sql`m.employee_id`)})`,
  };
}
