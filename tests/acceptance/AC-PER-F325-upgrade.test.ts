import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { appendEmployee } from '../../apps/api/src/modules/personnel/employee-write.js';
import { readEmployee } from '../../apps/api/src/modules/personnel/employee-read.js';
import { rows } from '../../apps/api/src/modules/personnel/store.js';
import { seedTenantWithMember } from './support/tenant-api.js';

const database = useTestDb({ migrateBefore: '_funny_king_cobra' });

it('AC-PER-F325 升级：保留旧档案版本，新列初始为空，升级后继续版本链并记录金额审计', async () => {
  const handle = database();
  const { tenant, user } = await seedTenantWithMember(handle.db, 'f325-upgrade');
  const employeeId = randomUUID();
  const firstId = randomUUID();
  const secondId = randomUUID();
  const snapshot = () =>
    withTenant(handle.db, tenant.id, async (tx) =>
      rows(
        await tx.execute(sql`SELECT to_jsonb(v) - 'daily_wage_standard' AS body
        FROM personnel_employee_versions v WHERE employee_id=${employeeId}::uuid ORDER BY revision`),
      ),
    );
  const columns = rows(
    await handle.db.execute(sql`SELECT column_name FROM information_schema.columns
    WHERE table_name='personnel_employee_versions' AND column_name='daily_wage_standard'`),
  );
  expect(columns).toEqual([]);
  // 旧结构只用显式列造两条历史版本，不能用新 schema 提前补出待验证的列。
  await withTenant(handle.db, tenant.id, async (tx) => {
    await tx.execute(sql`INSERT INTO employment_employees (id,tenant_id,code,name)
      VALUES (${employeeId},${tenant.id},${employeeId},'合成升级员工')`);
    await tx.execute(sql`INSERT INTO personnel_employee_versions
      (id,tenant_id,employee_id,revision,previous_version_id,command_id,created_by,name)
      VALUES (${firstId},${tenant.id},${employeeId},1,NULL,${randomUUID()},${user.id},'合成升级员工')`);
    await tx.execute(sql`INSERT INTO personnel_employee_versions
      (id,tenant_id,employee_id,revision,previous_version_id,command_id,created_by,name,eng_name)
      VALUES (${secondId},${tenant.id},${employeeId},2,${firstId},${randomUUID()},${user.id},
        '合成升级员工','Synthetic')`);
  });
  const before = await snapshot();
  await handle.migrate();
  await handle.migrate();
  expect(await snapshot()).toEqual(before);
  const context = {
    tenantId: tenant.id,
    userId: user.id,
    timezone: tenant.timezone,
    expectedRevision: 2,
    commandId: randomUUID(),
    now: new Date('2026-10-28T00:00:00.000Z'),
  };
  await withTenant(handle.db, tenant.id, async (tx) => {
    const old = rows(
      await tx.execute(sql`SELECT daily_wage_standard AS wage
      FROM personnel_employee_versions WHERE employee_id=${employeeId}::uuid ORDER BY revision`),
    );
    expect(old).toEqual([{ wage: null }, { wage: null }]);
    expect(await readEmployee(tx, context, employeeId)).toMatchObject({ dailyWageStandard: null, revision: 2 });
    expect(await appendEmployee(tx, context, employeeId, { dailyWageStandard: '123456789012.34' })).toBe(3);
    expect(await readEmployee(tx, context, employeeId)).toMatchObject({
      dailyWageStandard: '123456789012.34',
      revision: 3,
      engName: 'Synthetic',
    });
    const chain = rows(
      await tx.execute(sql`SELECT revision,previous_version_id,daily_wage_standard::text AS wage
      FROM personnel_employee_versions WHERE employee_id=${employeeId}::uuid ORDER BY revision`),
    );
    expect(chain).toEqual([
      { revision: 1, previous_version_id: null, wage: null },
      { revision: 2, previous_version_id: firstId, wage: null },
      { revision: 3, previous_version_id: secondId, wage: '123456789012.34' },
    ]);
    const audit = rows(
      await tx.execute(sql`SELECT "before","after" FROM audit_events
      WHERE object_id=${employeeId} AND command_id=${context.commandId}`),
    );
    expect(audit).toEqual([
      {
        before: expect.objectContaining({ dailyWageStandard: null }),
        after: expect.objectContaining({ dailyWageStandard: '123456789012.34' }),
      },
    ]);
  });
  expect((await snapshot()).slice(0, 2)).toEqual(before);
});
