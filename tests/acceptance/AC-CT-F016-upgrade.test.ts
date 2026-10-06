import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { legacyContractWorld } from './AC-CT-upgrade-support.js';
import { withPreAuditSchema } from './support/pre-audit-schema.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { allowAll, tenantApi } from './support/tenant-api.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';
import { runContractJobs } from '../../apps/api/src/modules/contracts/scheduler.js';

// 从 main 的 0049（合同校准前）升级；按后缀定位，不依赖合并后的迁移编号。
const database = useTestDb({ migrateBefore: '_contract_calibration' });
it('P2-N4 DEC-190 升级隔离整个冲突组，保留审批历史且无自动获胜者，受控撤销后重新提交', async () => {
  const handle = database();
  const w = await legacyContractWorld(handle.db);
  const tenantId = w.session.tenant.id;
  const ids = [randomUUID(), randomUUID()];
  const effectiveId = randomUUID();
  // 当前审批 / 平台接口会写 R1-T16 新增的审计列，旧结构上临时补出（只影响夹具，断言不变）
  await withPreAuditSchema(handle.db, () => installApprovalFallbacks(handle.db, tenantId, w.session.user.id));
  await withTenant(handle.db, tenantId, async (tx) => {
    await tx.execute(sql`INSERT INTO contract_records
      (id,tenant_id,employee_id,number,type_id,company_id,term_type,effective_date,end_date,signing_count,
        root_contract_id,version_no,created_by)
      VALUES (${effectiveId},${tenantId},${w.employee.id},'EFFECTIVE',${w.type.id},${w.company.id},'fixed',
        '2025-01-01','2026-10-31',1,${effectiveId},1,${w.session.user.id})`);
    await tx.execute(sql`INSERT INTO contract_requests
      (tenant_id,employee_id,number,type_id,company_id,term_type,effective_date,end_date,signing_count,
        operation,mode,status,result_id,created_by)
      VALUES (${tenantId},${w.employee.id},'EFFECTIVE',${w.type.id},${w.company.id},'fixed',
        '2025-01-01','2026-10-31',1,'create','direct','effective',${effectiveId},${w.session.user.id})`);
    for (const [i, id] of ids.entries()) {
      await tx.execute(sql`INSERT INTO contract_requests
        (id,tenant_id,employee_id,number,type_id,company_id,term_type,effective_date,end_date,signing_count,
          operation,mode,status,created_by)
        VALUES (${id},${tenantId},${w.employee.id},${`OLD-${i}`},${w.type.id},${w.company.id},'fixed',
          ${i ? '2026-12-01' : '2026-11-01'}::date,'2027-10-31',2,
          'create','application','approved',${w.session.user.id})`);
      await tx.execute(sql`INSERT INTO approval_instances
        (tenant_id,process_id,version_id,approval_type,object_code,business_type,business_id,
          subject_employee_id,initiator_user_id,title,status,business_version)
        SELECT ${tenantId},p.id,v.id,'contract_create','TenantBase.EmploymentContract','contract',${id},
          ${w.employee.id},${w.session.user.id},'旧批准记录','approved','revision:1'
        FROM approval_processes p JOIN approval_process_versions v ON v.process_id=p.id AND v.tenant_id=p.tenant_id
        WHERE p.tenant_id=${tenantId} AND p.approval_type='contract_create' AND v.status='published'`);
    }
  });
  await handle.migrate();
  const clock = () => new Date('2026-12-15T01:00:00Z');
  const api = tenantApi(handle.db, { clock });
  const identity = { tenant: tenantId, user: w.session.user.id };
  const failures = () => api.request('GET', '/api/tenant/contracts/failures', identity);
  expect(await (await failures()).json()).toMatchObject({
    items: expect.arrayContaining(
      ids.map((id) =>
        expect.objectContaining({ object_id: id, kind: 'quarantine', error: 'CONTRACT_IN_FLIGHT_QUARANTINED' }),
      ),
    ),
  });
  await runContractJobs(handle.db, { tenantId }, { clock, authorize: allowAll });
  const records = async () =>
    withTenant(handle.db, tenantId, async (tx) =>
      rowsOf(await tx.execute(sql`SELECT id FROM contract_records WHERE employee_id=${w.employee.id}::uuid`)),
    );
  expect(await records()).toEqual([{ id: effectiveId }]);
  const cancel = (id: string, revision = 1) =>
    api.request('POST', `/api/tenant/contracts/requests/${id}/cancel`, {
      ...identity,
      ifMatch: revision,
      body: {},
    });
  expect((await cancel(ids[0]!, 99)).status).toBe(409);
  expect((await cancel(ids[0]!)).status).toBe(200);
  // 只剩一份也不能自动恢复激活，必须显式重新提交。
  await runContractJobs(handle.db, { tenantId }, { clock, authorize: allowAll });
  expect(await records()).toEqual([{ id: effectiveId }]);
  expect((await cancel(ids[1]!)).status).toBe(200);
  expect(await (await failures()).json()).toMatchObject({ items: [] });
  const fresh = await api.request('POST', '/api/tenant/contracts/commands', {
    ...identity,
    ifMatch: 0,
    body: {
      operation: 'create',
      mode: 'application',
      employeeId: w.employee.id,
      fields: { typeId: w.type.id, companyId: w.company.id, effectiveDate: '2027-01-01', endDate: '2027-12-31' },
    },
  });
  expect(fresh.status, await fresh.clone().text()).toBe(201);
  expect(await fresh.json()).toMatchObject({ signingCount: 2, status: 'in_review' });
  await withTenant(handle.db, tenantId, async (tx) => {
    expect(
      rowsOf(
        await tx.execute(sql`SELECT status FROM approval_instances
      WHERE business_id IN (${ids[0]}::uuid,${ids[1]}::uuid)`),
      ),
    ).toEqual([{ status: 'approved' }, { status: 'approved' }]);
    expect(
      rowsOf(
        await tx.execute(sql`SELECT signing_count,status FROM contract_requests
      WHERE id IN (${ids[0]}::uuid,${ids[1]}::uuid)`),
      ),
    ).toEqual([
      { signing_count: 2, status: 'withdrawn' },
      { signing_count: 2, status: 'withdrawn' },
    ]);
    expect(
      rowsOf(
        await tx.execute(sql`SELECT id FROM audit_events
      WHERE action='contract.request.quarantine'`),
      ),
    ).toHaveLength(2);
    expect(
      rowsOf(
        await tx.execute(sql`SELECT id FROM contract_outbox
      WHERE event_type='contract.request.quarantine'`),
      ),
    ).toHaveLength(2);
  });
});
