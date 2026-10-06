import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';
const now = new Date('2026-10-01T01:00:00Z');

/** F-013 升级夹具固定使用 0046 之前的任职列；不能调用已依赖 0048 新列的当前入职 API。
 * 只构造同样的在职员工、合同类型和法人公司，历史合同/尝试及升级后的断言保持原样。
 */
export async function legacyContractWorld(db: Db) {
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
