import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
const database = useTestDb({ migrateBefore: '_f017_transfer_lifecycle' });
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
it('F-017 DEC-188 只基线登记历史未来调动，今日及上线后到期保留复查，迁移重跑不重复', async () => {
  const handle = database();
  const session = await employmentSession(handle.db, 'f017upgrade');
  const tenantId = session.tenant.id;
  const ids: string[] = [];
  for (const offset of [-1, 0, 1]) {
    const employee = await session.employee();
    const [staff, business, payload] = [randomUUID(), randomUUID(), randomUUID()];
    ids.push(business);
    await withTenant(handle.db, tenantId, async (tx) => {
      const date = sql`(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date + ${offset}::int`;
      await tx.execute(sql`INSERT INTO employment_cycles
        (id,tenant_id,employee_id,entry_date,entry_type,employ_type)
        VALUES (${staff},${tenantId},${employee.id},'2020-01-01','hire','internal')`);
      await tx.execute(sql`INSERT INTO employment_business_objects (id,tenant_id,employee_id)
        VALUES (${business},${tenantId},${employee.id})`);
      await tx.execute(sql`INSERT INTO employment_payload_versions
        (id,tenant_id,employee_id,business_id,version_no,kind,mode,effective_date,form_id,employ_type)
        VALUES (${payload},${tenantId},${employee.id},${business},1,'transfer','direct',${date},
          'standard','internal')`);
      await tx.execute(sql`INSERT INTO employment_state_events
        (tenant_id,employee_id,business_id,payload_version_id,event_no,state,command_id)
        VALUES (${tenantId},${employee.id},${business},${payload},1,'effective','legacy-transfer')`);
      await tx.execute(sql`INSERT INTO employment_records
        (id,tenant_id,employee_id,payload_version_id,staff_id,entry_date,kind,start_date,employ_type,created_at)
        VALUES (${business},${tenantId},${employee.id},${payload},${staff},'2020-01-01','transfer',${date},'internal',
          CURRENT_TIMESTAMP - interval '10 days')`);
      await tx.execute(sql`INSERT INTO employment_timeline
        (tenant_id,employee_id,record_id,staff_id,start_date,valid_during)
        VALUES (${tenantId},${employee.id},${business},${staff},${date},daterange(${date},NULL,'[)'))`);
    });
  }
  await handle.migrate();
  await handle.migrate();
  await withTenant(handle.db, tenantId, async (tx) => {
    expect(
      rows(
        await tx.execute(sql`SELECT business_id,detail->>'reason' AS reason,outcome FROM employment_activation_attempts
      WHERE tenant_id=${tenantId}`),
      ),
    ).toEqual([{ business_id: ids[0], reason: 'DEPLOYMENT_BASELINE', outcome: 'effective' }]);
  });
});
