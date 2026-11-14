/**
 * F-474-8c-2a app_user 最小授权（AC-INS-16 的方案 / 档案部分，设计 §3.5）：方案与方案版本由种子 / 导入脚本以属主身份写，
 * 运行时只读；档案版本是不可变版本链，运行时只追加（SELECT + INSERT），不得改、不得删、不得清表。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  archiveInsert,
  count,
  rowsOf,
  seedInsuranceWorld,
  sqlState,
  type InsuranceWorld,
} from './support/insurance-tables.js';

const testDb = useTestDb();
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;
const EXPECTED: Record<string, readonly (typeof PRIVILEGES)[number][]> = {
  social_insurance_plans: ['SELECT'],
  social_insurance_plan_versions: ['SELECT'],
  social_insurance_archive_versions: ['SELECT', 'INSERT'],
};
let w: InsuranceWorld;

beforeAll(async () => {
  w = await seedInsuranceWorld(testDb().db, 'priv');
  await withTenant(testDb().db, w.tenantId, (tx) =>
    tx.execute(archiveInsert(w.tenantId, { employeeId: w.employeeId, versionNo: 1, businessId: w.businessIds[0] })),
  );
});

const run = (statement: ReturnType<typeof sql>) => sqlState(testDb().db, w.tenantId, statement);

describe('AC-INS-16 方案 / 档案的 app_user 权限矩阵', () => {
  it('has_table_privilege 矩阵：方案与方案版本只读；档案只读 + 追加；没有任何表级写权限外溢', async () => {
    const granted: Record<string, string[]> = {};
    for (const table of Object.keys(EXPECTED)) {
      granted[table] = [];
      for (const privilege of PRIVILEGES) {
        const result = await testDb().db.execute(
          sql`SELECT has_table_privilege('app_user', ${table}, ${privilege}) AS ok`,
        );
        if (rowsOf<{ ok: boolean }>(result)[0]!.ok) granted[table]!.push(privilege);
      }
    }
    expect(granted).toEqual(EXPECTED);
  });

  it('方案与方案版本：运行时角色 INSERT / UPDATE / DELETE / TRUNCATE 一律 42501，内容不变', async () => {
    const attempts = [
      sql`INSERT INTO social_insurance_plans (tenant_id, code) VALUES (${w.tenantId}, 'RT-1')`,
      sql`UPDATE social_insurance_plans SET code = 'RT-2'`,
      sql`DELETE FROM social_insurance_plans`,
      sql`TRUNCATE social_insurance_plans`,
      sql`INSERT INTO social_insurance_plan_versions (tenant_id, plan_id, name, region_code, effective_month)
        VALUES (${w.tenantId}, ${w.planId}, 'RT', '110000', '2030-01-01')`,
      sql`UPDATE social_insurance_plan_versions SET name = 'RT'`,
      sql`DELETE FROM social_insurance_plan_versions`,
      sql`TRUNCATE social_insurance_plan_versions`,
    ];
    for (const attempt of attempts) expect(await run(attempt)).toBe('42501');
    expect(await count(testDb().db, w.tenantId, 'social_insurance_plans')).toBe(1);
    expect(await count(testDb().db, w.tenantId, 'social_insurance_plan_versions')).toBe(1);
  });

  it('档案：运行时可追加；UPDATE / DELETE / TRUNCATE 一律 42501，已有版本不变（不可变版本链）', async () => {
    expect(
      await run(archiveInsert(w.tenantId, { employeeId: w.employeeId, versionNo: 2, businessId: w.businessIds[1] })),
    ).toBeUndefined();
    for (const attempt of [
      sql`UPDATE social_insurance_archive_versions SET region_code = '110108'`,
      sql`DELETE FROM social_insurance_archive_versions`,
      sql`TRUNCATE social_insurance_archive_versions`,
    ])
      expect(await run(attempt)).toBe('42501');
    const rows = await withTenant(testDb().db, w.tenantId, async (tx) =>
      rowsOf<{ version_no: number; region_code: string | null }>(
        await tx.execute(
          sql`SELECT version_no, region_code FROM social_insurance_archive_versions ORDER BY version_no`,
        ),
      ),
    );
    expect(rows).toEqual([
      { version_no: 1, region_code: null },
      { version_no: 2, region_code: null },
    ]);
  });
});
