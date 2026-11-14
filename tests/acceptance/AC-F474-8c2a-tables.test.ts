/**
 * F-474-8c-2a 社保方案 / 档案表（设计 F-474-8b §3.2 / §3.3 / §3.4；AC-INS-10 表级、AC-INS-06 的“无 before_* 列”）。
 * 只验表结构、约束与租户隔离；读接口、联动保存体、生效子项、折叠属 8c-2b。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  archiveInsert,
  count,
  planVersionInsert,
  rowsOf,
  seedInsuranceWorld,
  sqlState,
  type InsuranceWorld,
} from './support/insurance-tables.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const TABLES = ['social_insurance_plans', 'social_insurance_plan_versions', 'social_insurance_archive_versions'];
let a: InsuranceWorld;
let b: InsuranceWorld;

beforeAll(async () => {
  a = await seedInsuranceWorld(testDb().db, 'A');
  b = await seedInsuranceWorld(testDb().db, 'B');
  await withTenant(testDb().db, a.tenantId, async (tx) => {
    await tx.execute(
      archiveInsert(a.tenantId, {
        employeeId: a.employeeId,
        versionNo: 1,
        businessId: a.businessIds[0],
        regionCode: '110108',
        planId: a.planId,
        companyId: a.companyId,
      }),
    );
  });
});

const run = (tenantId: string, statement: ReturnType<typeof sql>) => sqlState(testDb().db, tenantId, statement);

describe('AC-INS-10 表级：租户隔离', () => {
  it('三张新表都存在，且 ENABLE + FORCE ROW LEVEL SECURITY、带 tenant_isolation 策略', async () => {
    const result = await testDb().db.execute(sql`
      SELECT c.relname AS "table", c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
        (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS policies
      FROM pg_class c WHERE c.relname = ANY(${TABLES}) AND c.relkind = 'r' ORDER BY c.relname`);
    expect(rowsOf(result)).toEqual(
      [...TABLES].sort().map((table) => ({ table, rls: true, forced: true, policies: 1 })),
    );
  });

  it('A 租户读到自己的方案、方案版本、档案；B 租户（另一租户身份）三张表都读到 0 行', async () => {
    for (const table of TABLES) expect(await count(testDb().db, a.tenantId, table), table).toBe(1);
    // B 自己各有 1 行方案 / 版本，档案为 0；关键是看不到 A 的行
    const seen = await withTenant(testDb().db, b.tenantId, async (tx) =>
      rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT
          (SELECT count(*)::int FROM social_insurance_plans WHERE tenant_id = ${a.tenantId}) +
          (SELECT count(*)::int FROM social_insurance_plan_versions WHERE tenant_id = ${a.tenantId}) +
          (SELECT count(*)::int FROM social_insurance_archive_versions WHERE tenant_id = ${a.tenantId}) AS n`),
      ),
    );
    expect(seen).toEqual([{ n: 0 }]);
    expect(await count(testDb().db, b.tenantId, 'social_insurance_archive_versions')).toBe(0);
  });

  it('B 租户上下文往 A 租户写方案 / 版本 / 档案一律被行级策略拒绝（42501），A 的内容不变', async () => {
    const planId = randomUUID();
    const statements = [
      sql`INSERT INTO social_insurance_plans (tenant_id, id, code) VALUES (${a.tenantId}, ${planId}, ${`X-${uniqueSuffix()}`})`,
      planVersionInsert(a.tenantId, a.planId, '2027-01-01'),
      archiveInsert(a.tenantId, { employeeId: a.employeeId, versionNo: 9, businessId: a.businessIds[1] }),
    ];
    for (const statement of statements) expect(await run(b.tenantId, statement)).toBe('42501');
    for (const table of TABLES) expect(await count(testDb().db, a.tenantId, table), table).toBe(1);
  });

  it('B 租户的档案 / 方案版本引用 A 租户的方案、公司、员工、调动单都被外键拒绝（23503）', async () => {
    const own = { employeeId: b.employeeId, versionNo: 1, businessId: b.businessIds[0] };
    expect(await run(b.tenantId, archiveInsert(b.tenantId, { ...own, planId: a.planId }))).toBe('23503');
    expect(await run(b.tenantId, archiveInsert(b.tenantId, { ...own, companyId: a.companyId }))).toBe('23503');
    expect(await run(b.tenantId, archiveInsert(b.tenantId, { ...own, employeeId: a.employeeId }))).toBe('23503');
    expect(await run(b.tenantId, archiveInsert(b.tenantId, { ...own, businessId: a.businessIds[0] }))).toBe('23503');
    expect(await run(b.tenantId, planVersionInsert(b.tenantId, a.planId, '2027-01-01'))).toBe('23503');
    expect(await count(testDb().db, b.tenantId, 'social_insurance_archive_versions')).toBe(0);
  });
});

describe('§3.3 档案版本链约束', () => {
  const columns = async () =>
    rowsOf<{ column_name: string }>(
      await testDb().db.execute(sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'social_insurance_archive_versions' ORDER BY ordinal_position`),
    ).map((r) => r.column_name);

  it('列与设计一致：只存本业务调整值，没有任何 before_* 列（变更前从版本链取）', async () => {
    expect(await columns()).toEqual([
      'tenant_id',
      'id',
      'employee_id',
      'version_no',
      'effective_date',
      'planned_effective_date',
      'operation_seq',
      'region_code',
      'plan_id',
      'company_id',
      'source',
      'source_business_id',
      'command_id',
      'created_at',
    ]);
  });

  it('(tenant, employee, version_no) 唯一：同员工重复追加序号 → 23505', async () => {
    const row = { employeeId: a.employeeId, versionNo: 1, businessId: a.businessIds[2] };
    expect(await run(a.tenantId, archiveInsert(a.tenantId, row))).toBe('23505');
  });

  it('(tenant, source, source_business_id) 唯一：同一调动单重复写档案 → 23505（幂等键）', async () => {
    const row = { employeeId: a.employeeId, versionNo: 2, businessId: a.businessIds[0] };
    expect(await run(a.tenantId, archiveInsert(a.tenantId, row))).toBe('23505');
  });

  it('不按日期唯一：同员工同生效日、两个不同来源业务的两条档案可以共存', async () => {
    const w = await seedInsuranceWorld(testDb().db, 'same-day');
    const effectiveDate = '2026-05-01';
    await withTenant(testDb().db, w.tenantId, async (tx) => {
      await tx.execute(
        archiveInsert(w.tenantId, {
          employeeId: w.employeeId,
          versionNo: 1,
          businessId: w.businessIds[0],
          effectiveDate,
        }),
      );
      await tx.execute(
        archiveInsert(w.tenantId, {
          employeeId: w.employeeId,
          versionNo: 2,
          businessId: w.businessIds[1],
          effectiveDate,
          regionCode: '110108',
        }),
      );
    });
    const rows = await withTenant(testDb().db, w.tenantId, async (tx) =>
      rowsOf<{ version_no: number }>(
        await tx.execute(sql`SELECT version_no FROM social_insurance_archive_versions
          WHERE employee_id = ${w.employeeId} AND effective_date = ${effectiveDate} ORDER BY version_no`),
      ),
    );
    expect(rows.map((r) => r.version_no)).toEqual([1, 2]);
  });

  it("source 只允许 'transfer'：其它来源被 CHECK 拒绝（23514）", async () => {
    const row = { employeeId: a.employeeId, versionNo: 5, businessId: a.businessIds[1] };
    for (const source of ['entry', 'exit', 'contract', 'Transfer'])
      expect(await run(a.tenantId, archiveInsert(a.tenantId, { ...row, source })), source).toBe('23514');
  });

  it('版本号 ≤ 0 被 CHECK 拒绝；非字典缴交地 / 跨租户外键 / 来源业务不存在被外键拒绝', async () => {
    const row = { employeeId: a.employeeId, versionNo: 6, businessId: a.businessIds[1] };
    expect(await run(a.tenantId, archiveInsert(a.tenantId, { ...row, versionNo: 0 }))).toBe('23514');
    expect(await run(a.tenantId, archiveInsert(a.tenantId, { ...row, regionCode: '999999' }))).toBe('23503');
    expect(await run(a.tenantId, archiveInsert(a.tenantId, { ...row, planId: randomUUID() }))).toBe('23503');
    expect(await run(a.tenantId, archiveInsert(a.tenantId, { ...row, companyId: randomUUID() }))).toBe('23503');
    expect(await run(a.tenantId, archiveInsert(a.tenantId, { ...row, businessId: randomUUID() }))).toBe('23503');
    expect(await count(testDb().db, a.tenantId, 'social_insurance_archive_versions')).toBe(1);
  });
});

describe('§3.2 方案头与版本约束', () => {
  it('方案业务编码租户内唯一：同租户重复 → 23505，另一租户同编码可用', async () => {
    const code = `DUP-${uniqueSuffix()}`;
    const insert = (tenantId: string) =>
      sql`INSERT INTO social_insurance_plans (tenant_id, code) VALUES (${tenantId}, ${code})`;
    expect(await run(a.tenantId, insert(a.tenantId))).toBeUndefined();
    expect(await run(a.tenantId, insert(a.tenantId))).toBe('23505');
    expect(await run(b.tenantId, insert(b.tenantId))).toBeUndefined();
  });

  it('同一方案同月重复生效被拒（23505）', async () => {
    expect(await run(a.tenantId, planVersionInsert(a.tenantId, a.planId, '2026-01-01', '2026-03-01'))).toBe('23505');
  });

  it('同一方案区间重叠被排他约束拒绝（23P01）；首尾相接、别的方案同期不算重叠', async () => {
    const plan = await withTenant(testDb().db, a.tenantId, async (tx) => {
      const id = randomUUID();
      await tx.execute(sql`INSERT INTO social_insurance_plans (tenant_id, id, code)
        VALUES (${a.tenantId}, ${id}, ${`OV-${uniqueSuffix()}`})`);
      await tx.execute(planVersionInsert(a.tenantId, id, '2026-01-01', '2026-06-01'));
      return id;
    });
    // 与 [2026-01, 2026-06) 重叠：从 2026-03 起长期有效 / 完全包含 / 被包含
    expect(await run(a.tenantId, planVersionInsert(a.tenantId, plan, '2026-03-01'))).toBe('23P01');
    expect(await run(a.tenantId, planVersionInsert(a.tenantId, plan, '2025-12-01', '2026-02-01'))).toBe('23P01');
    expect(await run(a.tenantId, planVersionInsert(a.tenantId, plan, '2026-02-01', '2026-04-01'))).toBe('23P01');
    // 首尾相接合法（半开区间）；别的方案同期合法
    expect(await run(a.tenantId, planVersionInsert(a.tenantId, plan, '2026-06-01', '2026-09-01'))).toBeUndefined();
    expect(await run(a.tenantId, planVersionInsert(a.tenantId, a.planId, '2025-01-01', '2026-01-01'))).toBeUndefined();
    // 长期有效版本之后再加更晚版本也重叠
    expect(await run(a.tenantId, planVersionInsert(a.tenantId, plan, '2027-01-01'))).toBeUndefined();
    expect(await run(a.tenantId, planVersionInsert(a.tenantId, plan, '2028-01-01'))).toBe('23P01');
  });

  it('生效月必须是月初；停用月须晚于生效月；revision 须为正；缴交地须在字典内', async () => {
    const plan = a.planId;
    expect(await run(a.tenantId, planVersionInsert(a.tenantId, plan, '2024-01-15'))).toBe('23514');
    expect(await run(a.tenantId, planVersionInsert(a.tenantId, plan, '2024-01-01', '2024-01-01'))).toBe('23514');
    expect(await run(a.tenantId, planVersionInsert(a.tenantId, plan, '2024-01-01', '2023-12-01'))).toBe('23514');
    expect(await run(a.tenantId, planVersionInsert(a.tenantId, plan, '2024-01-01', null, '999999'))).toBe('23503');
    expect(
      await run(
        a.tenantId,
        sql`INSERT INTO social_insurance_plan_versions (tenant_id, plan_id, name, region_code, effective_month, revision)
          VALUES (${a.tenantId}, ${plan}, '合成', '110000', '2024-01-01', 0)`,
      ),
    ).toBe('23514');
  });

  it('方案版本没有 before_* 列，也没有公司 / 险种明细列（最小集）', async () => {
    const result = await testDb().db.execute(sql`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'social_insurance_plan_versions' ORDER BY ordinal_position`);
    expect(rowsOf<{ column_name: string }>(result).map((r) => r.column_name)).toEqual([
      'tenant_id',
      'id',
      'plan_id',
      'name',
      'region_code',
      'effective_month',
      'stop_month',
      'enabled',
      'revision',
    ]);
  });
});

describe('§3.4 transfer_linkage_versions 追加三列', () => {
  const insertLinkage = (
    w: InsuranceWorld,
    businessId: string,
    adjusted: { region?: string | null; plan?: string | null; company?: string | null },
  ) => sql`INSERT INTO transfer_linkage_versions
    (tenant_id, employee_id, business_id, version_no, command_id,
     adjusted_insurance_region_code, adjusted_insurance_plan_id, adjusted_insurance_company_id)
    VALUES (${w.tenantId}, ${w.employeeId}, ${businessId}, 1, ${`cmd-${uniqueSuffix()}`},
      ${adjusted.region ?? null}, ${adjusted.plan ?? null}, ${adjusted.company ?? null})`;

  it('三列可空：不填也能写联动版本；填合法值（3 级字典内 code、本租户方案 / 公司）可写', async () => {
    const w = await seedInsuranceWorld(testDb().db, 'linkage');
    expect(await run(w.tenantId, insertLinkage(w, w.businessIds[0], {}))).toBeUndefined();
    expect(
      await run(
        w.tenantId,
        insertLinkage(w, w.businessIds[1], { region: '110108', plan: w.planId, company: w.companyId }),
      ),
    ).toBeUndefined();
    const rows = await withTenant(testDb().db, w.tenantId, async (tx) =>
      rowsOf(
        await tx.execute(sql`SELECT business_id, adjusted_insurance_region_code AS region,
          adjusted_insurance_plan_id AS plan, adjusted_insurance_company_id AS company
          FROM transfer_linkage_versions ORDER BY region NULLS FIRST`),
      ),
    );
    expect(rows).toEqual([
      { business_id: w.businessIds[0], region: null, plan: null, company: null },
      { business_id: w.businessIds[1], region: '110108', plan: w.planId, company: w.companyId },
    ]);
  });

  it('非字典缴交地 code、跨租户方案、跨租户公司、不存在的方案 / 公司都被外键拒绝（23503）', async () => {
    expect(await run(b.tenantId, insertLinkage(b, b.businessIds[0], { region: '999999' }))).toBe('23503');
    expect(await run(b.tenantId, insertLinkage(b, b.businessIds[0], { plan: a.planId }))).toBe('23503');
    expect(await run(b.tenantId, insertLinkage(b, b.businessIds[0], { company: a.companyId }))).toBe('23503');
    expect(await run(b.tenantId, insertLinkage(b, b.businessIds[0], { plan: randomUUID() }))).toBe('23503');
    expect(await run(b.tenantId, insertLinkage(b, b.businessIds[0], { company: randomUUID() }))).toBe('23503');
    expect(await count(testDb().db, b.tenantId, 'transfer_linkage_versions')).toBe(0);
  });
});
