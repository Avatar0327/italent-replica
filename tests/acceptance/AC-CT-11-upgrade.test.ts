import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';

const testDb = useTestDb({ migrateBefore: '_contract_import_guard' });
it('AC-CT-11 升级压缩历史尝试、保留累计次数与成功终态，旧终止原因保守回填', async () => {
  const handle = testDb();
  const w = await legacyContractWorld(handle.db);
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

/** F-013 升级夹具固定使用 0046 之前的任职列；不能调用已依赖 0048 新列的当前入职 API。
 * 只构造同样的在职员工、合同类型和法人公司，历史合同/尝试及升级后的断言保持原样。
 */
async function legacyContractWorld(db: Db) {
  const session = await employmentSession(db, 'f013upgrade');
  const org = await session.org('合同部门', { establishedOn: '2025-01-01' });
  const employee = await session.employee();
  const type = { id: randomUUID() };
  const company = { id: randomUUID() };
  const [staffId, businessId, payloadId] = [randomUUID(), randomUUID(), randomUUID()];
  await withTenant(db, session.tenant.id, async (tx) => {
    const tenantId = session.tenant.id;
    await tx.execute(sql`INSERT INTO employment_cycles (id,tenant_id,employee_id,entry_date,entry_type,employ_type)
      VALUES (${staffId},${tenantId},${employee.id},'2025-01-01','hire','internal')`);
    await tx.execute(sql`INSERT INTO employment_business_objects (id,tenant_id,employee_id)
      VALUES (${businessId},${tenantId},${employee.id})`);
    await tx.execute(sql`INSERT INTO employment_payload_versions
      (id,tenant_id,employee_id,business_id,version_no,kind,mode,effective_date,form_id,department_id,employ_type)
      VALUES (${payloadId},${tenantId},${employee.id},${businessId},1,'hire','direct','2025-01-01',
        'standard',${org.id},'internal')`);
    await tx.execute(sql`INSERT INTO employment_state_events
      (tenant_id,employee_id,business_id,payload_version_id,event_no,state,command_id)
      VALUES (${tenantId},${employee.id},${businessId},${payloadId},1,'effective','legacy-hire')`);
    await tx.execute(sql`INSERT INTO employment_records
      (id,tenant_id,employee_id,payload_version_id,staff_id,entry_date,kind,start_date,department_id,employ_type)
      VALUES (${businessId},${tenantId},${employee.id},${payloadId},${staffId},'2025-01-01','hire','2025-01-01',
        ${org.id},'internal')`);
    await tx.execute(sql`INSERT INTO employment_timeline
      (tenant_id,employee_id,record_id,staff_id,start_date,valid_during)
      VALUES (${tenantId},${employee.id},${businessId},${staffId},'2025-01-01',
        daterange('2025-01-01'::date,NULL,'[)'))`);
    await tx.execute(sql`INSERT INTO contract_types (id,tenant_id,code,name)
      VALUES (${type.id},${tenantId},'legacy-type','劳动合同')`);
    await tx.execute(sql`INSERT INTO contract_companies (id,tenant_id,code,name)
      VALUES (${company.id},${tenantId},'legacy-company','合成法人公司')`);
  });
  const api = tenantApi(db, { clock: () => now });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/contracts${path}`, {
      ...options,
      user: session.user.id,
      tenant: session.tenant.id,
    });
  return { session, employee, type, company, request };
}
