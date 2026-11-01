/**
 * 人员结构分析（B49）与员工结构两张报表（B53）的取数（docs/02_业务建模/35“补充：BE-13…”、“员工结构两张报表”）。
 * 单一入口 structurePeople：asOf 当天在职的主职任职（人事看板 inServiceFrom，与“正式员工”指标同一谓词）先叠加
 * DEC-177 可见谓词，每人一行带分段所需的属性；看板数字、分组、明细与报表单元格都由这份行集经 domain 的分段工具算出，
 * 不另写第二套条件。组织按 asOf 当天的行政上级链解析（orgTree）。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { rowsOf } from '../employment/read-model.js';
import { current, employmentVisible, employType, inServiceFrom, type DashboardAsOf } from './hr-dashboard.js';

export interface StructurePerson {
  readonly id: string;
  readonly departmentId: string | null;
  readonly sequenceId: string | null;
  readonly levelId: string | null;
  readonly employmentForm: string | null;
  /** 人员类别（任职字段 employment_type）。 */
  readonly employmentType: string | null;
  readonly employmentSource: string | null;
  /** 雇佣关系（internal / intern）。 */
  readonly employType: string;
  readonly employeeStatus: number;
  readonly entryDate: string | null;
  readonly gender: string | null;
  readonly birthday: string | null;
  readonly educationLevel: string | null;
}

type StructureContext = Pick<DashboardAsOf, 'tenantId' | 'asOf' | 'scope'>;
const attribute = (column: string, alias: string) => sql`${current(column)} AS ${sql.identifier(alias)}`;

/** 范围内、asOf 当天在职且雇佣关系属于 employTypes 的人员（每人取当天最新一段主职任职），按员工 ID 排序。 */
export async function structurePeople(
  tx: Tx,
  a: StructureContext,
  employTypes: readonly string[],
): Promise<StructurePerson[]> {
  const columns: SQL[] = [
    attribute('department_id', 'departmentId'),
    attribute('sequence_id', 'sequenceId'),
    attribute('level_id', 'levelId'),
    attribute('employment_form', 'employmentForm'),
    attribute('employment_type', 'employmentType'),
    attribute('employment_source', 'employmentSource'),
    attribute('employ_type', 'employType'),
  ];
  return rowsOf<StructurePerson>(
    await tx.execute(sql`SELECT m.id, m."departmentId", m."sequenceId", m."levelId", m."employmentForm",
        m."employmentType", m."employmentSource", m."employType", m."employeeStatus", m."entryDate",
        pv.gender, pv.birthday::text AS birthday, pv.education_level AS "educationLevel"
      FROM (SELECT DISTINCT ON (r.employee_id) r.employee_id AS id, r.employee_id,
          ${current('department_id')} AS org_id, NULL::uuid AS creator_id, ${sql.join(columns, sql`, `)},
          s.employee_status::int AS "employeeStatus", r.entry_date::text AS "entryDate"
        ${inServiceFrom(a, employType(employTypes))}
        ORDER BY r.employee_id, t.start_date DESC, t.sort_order DESC) m
      LEFT JOIN LATERAL (SELECT v.gender, v.birthday, v.education_level FROM personnel_employee_versions v
        WHERE v.tenant_id=${a.tenantId} AND v.employee_id=m.employee_id ORDER BY v.revision DESC LIMIT 1) pv ON true
      WHERE ${employmentVisible(a, sql`m`)}
      ORDER BY m.id`),
  );
}

interface OrgNode {
  readonly name: string;
  readonly broadType: string;
  readonly parentId: string | null;
}

/** asOf 当天的组织树（行政维度）：任职机构、一级组织与“含下级”的部门筛选都按这棵树上溯。 */
export interface OrgTree {
  readonly root: string;
  name(orgId: string): string;
  /** 自身在前、逐级上溯到租户根组织（上级链断开或成环时止于最后一个可达节点）。 */
  chain(orgId: string | null): string[];
  /** 最近的“机构”大类组织（含自身，不含根）；没有时回落租户根组织。 */
  institution(orgId: string | null): string;
  /** 一级组织 = 租户根下第一层；挂在根上的人归根组织。 */
  level1(orgId: string | null): string;
}

const MAX_DEPTH = 64;

export async function orgTree(tx: Tx, tenantId: string, asOf: string): Promise<OrgTree> {
  const rows = rowsOf<{ id: string } & OrgNode>(
    await tx.execute(sql`SELECT v.org_id AS id, v.name, v.broad_type AS "broadType", l.parent_org_id AS "parentId"
      FROM (SELECT DISTINCT ON (org_id) id, org_id, name, broad_type FROM org_versions
        WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date
        ORDER BY org_id, start_date DESC, version_no DESC) v
      LEFT JOIN org_hierarchy_links l ON l.tenant_id=${tenantId} AND l.version_id=v.id AND l.dimension='admin'`),
  );
  const nodes = new Map(rows.map((row) => [row.id, row]));
  const chain = (orgId: string | null) => {
    const path: string[] = [];
    for (let id = orgId ?? tenantId; path.length < MAX_DEPTH && !path.includes(id);) {
      path.push(id);
      const parent = nodes.get(id)?.parentId;
      if (id === tenantId || !parent) break;
      id = parent;
    }
    return path;
  };
  return {
    root: tenantId,
    name: (orgId) => nodes.get(orgId)?.name ?? orgId,
    chain,
    institution: (orgId) =>
      chain(orgId).find((id) => id !== tenantId && nodes.get(id)?.broadType === '机构') ?? tenantId,
    level1: (orgId) => {
      const path = chain(orgId);
      const top = path.indexOf(tenantId);
      if (top === 0) return tenantId;
      return top > 0 ? path[top - 1]! : path[path.length - 1]!;
    },
  };
}

export interface DictionaryItem {
  readonly id: string;
  readonly name: string;
  /** asOf 当天启用且未停用（报表按它展开列；停用项只用于给已有引用取名称）。 */
  readonly active: boolean;
}

/** 职务序列 / 职级字典在 asOf 当天的版本，按显示顺序、编码排序。 */
export async function jobDictionary(
  tx: Tx,
  tenantId: string,
  asOf: string,
  kind: 'sequence' | 'level',
): Promise<DictionaryItem[]> {
  const table = sql.identifier(kind === 'sequence' ? 'job_sequence_versions' : 'job_level_versions');
  const rows = rowsOf<{ id: string; name: string; active: boolean }>(
    await tx.execute(sql`SELECT id, name, active FROM (SELECT DISTINCT ON (object_id) object_id AS id, name, code,
        display_order, enabled AND stop_date>=${asOf}::date AS active
      FROM ${table} WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date
      ORDER BY object_id, start_date DESC, version_no DESC) d
      ORDER BY display_order NULLS LAST, code COLLATE "C", id`),
  );
  return rows;
}
