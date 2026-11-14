/** F-474-8c-2a：社保方案 / 档案三张表的表级夹具（设计 §3.2 / §3.3）。只用合成数据，邮箱 / 编码带唯一后缀。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { pgErrorCode } from '@italent/testkit';
import { uniqueSuffix } from './unique.js';

export interface InsuranceWorld {
  readonly tenantId: string;
  readonly employeeId: string;
  /** 三个调动单业务对象（档案 source_business_id 的合法取值）。 */
  readonly businessIds: readonly [string, string, string];
  readonly companyId: string;
  readonly planId: string;
  readonly planVersionId: string;
}

export const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

/** 一个租户 + 一名员工 + 三个业务对象 + 一家合同公司 + 一个带一条版本（2026-01 起长期有效）的方案。 */
export async function seedInsuranceWorld(db: Db, label: string): Promise<InsuranceWorld> {
  const tenantId = randomUUID();
  const suffix = uniqueSuffix();
  await db.execute(sql`INSERT INTO tenants (id, code, name) VALUES (${tenantId}, ${`i8c2a-${suffix}`}, ${label})`);
  const employeeId = randomUUID();
  const businessIds = [randomUUID(), randomUUID(), randomUUID()] as const;
  const companyId = randomUUID();
  const planId = randomUUID();
  const planVersionId = randomUUID();
  await withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`INSERT INTO employment_employees (id, tenant_id, code, name)
      VALUES (${employeeId}, ${tenantId}, ${`E-${suffix}`}, '合成员工')`);
    for (const id of businessIds)
      await tx.execute(sql`INSERT INTO employment_business_objects (id, tenant_id, employee_id)
        VALUES (${id}, ${tenantId}, ${employeeId})`);
    await tx.execute(sql`INSERT INTO contract_companies (id, tenant_id, code, name)
      VALUES (${companyId}, ${tenantId}, ${`C-${suffix}`}, '合成公司')`);
    await tx.execute(sql`INSERT INTO social_insurance_plans (tenant_id, id, code)
      VALUES (${tenantId}, ${planId}, ${`P-${suffix}`})`);
    await tx.execute(sql`INSERT INTO social_insurance_plan_versions
      (tenant_id, id, plan_id, name, region_code, effective_month)
      VALUES (${tenantId}, ${planVersionId}, ${planId}, '合成方案', '110000', '2026-01-01')`);
  });
  return { tenantId, employeeId, businessIds, companyId, planId, planVersionId };
}

export interface ArchiveRow {
  readonly employeeId: string;
  readonly versionNo: number;
  readonly effectiveDate?: string;
  readonly source?: string;
  readonly businessId: string;
  readonly regionCode?: string | null;
  readonly planId?: string | null;
  readonly companyId?: string | null;
}

/** 档案版本一行（带齐非空列；调整值默认全空，由用例按需给）。 */
export const archiveInsert = (tenantId: string, row: ArchiveRow) => sql`INSERT INTO social_insurance_archive_versions
  (tenant_id, employee_id, version_no, effective_date, planned_effective_date, operation_seq,
   region_code, plan_id, company_id, source, source_business_id, command_id)
  VALUES (${tenantId}, ${row.employeeId}, ${row.versionNo}, ${row.effectiveDate ?? '2026-03-01'},
    ${row.effectiveDate ?? '2026-03-01'}, ${row.versionNo}, ${row.regionCode ?? null}, ${row.planId ?? null},
    ${row.companyId ?? null}, ${row.source ?? 'transfer'}, ${row.businessId}, ${`cmd-${uniqueSuffix()}`})`;

/** 方案版本一行；month 为生效月（必须是 1 号）。 */
export const planVersionInsert = (
  tenantId: string,
  planId: string,
  effectiveMonth: string,
  stopMonth: string | null = null,
  regionCode = '110000',
) => sql`INSERT INTO social_insurance_plan_versions
  (tenant_id, plan_id, name, region_code, effective_month, stop_month)
  VALUES (${tenantId}, ${planId}, '合成方案版本', ${regionCode}, ${effectiveMonth}, ${stopMonth})`;

/** 在租户上下文里执行语句，返回抛出的 SQLSTATE（成功返回 undefined），一行断言用。 */
export async function sqlState(db: Db, tenantId: string, statement: ReturnType<typeof sql>) {
  return withTenant(db, tenantId, (tx: Tx) => tx.execute(statement)).then(
    () => undefined,
    (error: unknown) => pgErrorCode(error),
  );
}

export const count = async (db: Db, tenantId: string, table: string): Promise<number> =>
  withTenant(db, tenantId, async (tx) => {
    const [row] = rowsOf<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`));
    return row!.n;
  });
