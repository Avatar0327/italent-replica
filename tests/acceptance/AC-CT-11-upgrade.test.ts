import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { contractWorld } from './AC-CT-support.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';

const testDb = useTestDb({ migrateBefore: '_contract_import_guard' });
it('AC-CT-11 升级压缩历史尝试、保留累计次数与成功终态，旧终止原因保守回填', async () => {
  const handle = testDb();
  const w = await contractWorld(handle.db, 'f013upgrade');
  const objects = [randomUUID(), randomUUID(), randomUUID()];
  await withTenant(handle.db, w.session.tenant.id, async (tx) => {
    for (const [i, id] of objects.entries()) {
      await tx.execute(sql`INSERT INTO contract_records
        (id,tenant_id,employee_id,number,type_id,company_id,term_type,effective_date,end_date,
          actual_termination_date,signing_count,root_contract_id,version_no,status,created_by)
        VALUES (${id},${w.session.tenant.id},${w.employee.id},${`LEGACY-${i}`},${w.type.id},${w.company.id},
          'fixed','2025-01-01','2026-09-30',${i === 0 ? '2026-09-30' : '2026-09-20'},1,${id},1,
          'terminated',${w.session.user.id})`);
      for (const [j, state] of ['failed', i === 0 ? 'succeeded' : 'skipped', 'unknown'].entries()) {
        await tx.execute(sql`INSERT INTO contract_job_attempts
          (tenant_id,object_id,employee_id,kind,state,error,command_id,created_at)
          VALUES (${w.session.tenant.id},${id},${w.employee.id},'renew',${state},
            ${state === 'unknown' ? 'SERVICE_UNAVAILABLE' : null},${`legacy-${i}`},
            ${new Date(now.getTime() + j * 1000).toISOString()}::timestamptz)`);
      }
    }
  });
  await handle.migrate();
  await withTenant(handle.db, w.session.tenant.id, async (tx) => {
    const attempts = rowsOf(
      await tx.execute(sql`SELECT object_id,state,error,attempt_count
      FROM contract_job_attempts WHERE tenant_id=${w.session.tenant.id}`),
    );
    expect(attempts).toHaveLength(3);
    expect(attempts).toContainEqual({ object_id: objects[0], state: 'succeeded', error: null, attempt_count: 3 });
    expect(attempts).toContainEqual({
      object_id: objects[1],
      state: 'unknown',
      error: 'SERVICE_UNAVAILABLE',
      attempt_count: 3,
    });
    const contracts = rowsOf(
      await tx.execute(sql`SELECT id,termination_reason FROM contract_records
      WHERE tenant_id=${w.session.tenant.id}`),
    );
    expect(contracts).toContainEqual({ id: objects[0], termination_reason: 'expiry' });
    expect(contracts).toContainEqual({ id: objects[1], termination_reason: 'unknown' });
  });
  const response = await w.request('POST', '/imports', {
    ifMatch: 0,
    body: {
      mode: 'edit',
      rows: [{ employeeId: w.employee.id, revision: 1, fields: { number: 'LEGACY-0', endDate: '2026-12-31' } }],
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
});
const now = new Date('2026-10-01T01:00:00Z');
