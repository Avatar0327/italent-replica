/**
 * F-474-8c-2c 迁移（设计 §3.3 / §6，DEC-402）：transfer_linkage_items 的 item_type CHECK 追加 'insurance_archive'，
 * 旧三个取值照常可写，其余取值仍被拒。CHECK 在行级先于外键触发：允许的取值只会撞上“没有联动运行记录”的外键（23503），
 * 不允许的取值撞 CHECK（23514）。普通角色 app_owner 下同样可跑（asOwner 只设租户，不切角色）。
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { asOwner, rowsOf, seedInsuranceWorld } from './support/insurance-tables.js';

const testDb = useTestDb();

describe('transfer_linkage_items_type 追加 insurance_archive', () => {
  async function attempt(itemType: string) {
    const world = await seedInsuranceWorld(testDb().db, 'ins-migration');
    return asOwner(testDb().db, world.tenantId, async (tx) => {
      await tx.execute(sql`SAVEPOINT item_try`);
      try {
        await tx.execute(sql`INSERT INTO transfer_linkage_items
          (id, tenant_id, employee_id, business_id, line_no, item_type, effective_date, status)
          VALUES (${randomUUID()}, ${world.tenantId}, ${world.employeeId}, ${world.businessIds[0]}, 1,
            ${itemType}, '2026-10-10', 'pending')`);
        return 'inserted';
      } catch (error) {
        return pgErrorCode(error);
      }
    });
  }

  it.each(['duty_subordinate', 'duty_org_role', 'part_time_end', 'insurance_archive'])(
    '允许 %s：通过 CHECK（只撞外键 23503，不撞 23514）',
    async (itemType) => {
      expect(await attempt(itemType)).toBe('23503');
    },
  );

  it.each(['insurance', 'salary', '', 'INSURANCE_ARCHIVE'])('仍拒绝 %j（CHECK 23514）', async (itemType) => {
    expect(await attempt(itemType)).toBe('23514');
  });

  it('约束定义含四个取值', async () => {
    const world = await seedInsuranceWorld(testDb().db, 'ins-migration-def');
    const [row] = await asOwner(testDb().db, world.tenantId, async (tx) =>
      rowsOf<{ def: string }>(
        await tx.execute(sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname='transfer_linkage_items_type'`),
      ),
    );
    for (const type of ['duty_subordinate', 'duty_org_role', 'part_time_end', 'insurance_archive'])
      expect(row!.def).toContain(`'${type}'`);
  });
});
