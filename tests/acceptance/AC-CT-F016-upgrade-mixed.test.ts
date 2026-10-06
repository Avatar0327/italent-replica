import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { legacyContractWorld } from './AC-CT-upgrade-support.js';
import { withPreAuditSchema } from './support/pre-audit-schema.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';
import { applyRequest, loadRequest } from '../../apps/api/src/modules/contracts/service.js';

const database = useTestDb({ migrateBefore: '_contract_calibration' });
it('DEC-190 混合审批中/未来编辑全组隔离，越权不可撤销，关闭待办且保存审批轨迹', async () => {
  const handle = database();
  const w = await legacyContractWorld(handle.db);
  const tenantId = w.session.tenant.id;
  const ids = [randomUUID(), randomUUID()];
  const target = randomUUID();
  // 当前审批 / 平台接口会写 R1-T16 新增的审计列，旧结构上临时补出（只影响夹具，断言不变）
  await withPreAuditSchema(handle.db, () => installApprovalFallbacks(handle.db, tenantId, w.session.user.id));
  await withTenant(handle.db, tenantId, async (tx) => {
    await tx.execute(sql`INSERT INTO contract_records
      (id,tenant_id,employee_id,number,type_id,company_id,term_type,effective_date,end_date,
        signing_count,root_contract_id,version_no,created_by)
      VALUES (${target},${tenantId},${w.employee.id},'MIXED',${w.type.id},${w.company.id},'fixed',
        '2025-01-01','2027-10-31',1,${target},1,${w.session.user.id})`);
    for (const [i, id] of ids.entries()) {
      await tx.execute(sql`INSERT INTO contract_requests
        (id,tenant_id,employee_id,number,type_id,company_id,term_type,effective_date,end_date,signing_count,
          operation,mode,status,target_id,target_revision,created_by)
        VALUES (${id},${tenantId},${w.employee.id},${`MIXED-${i}`},${w.type.id},${w.company.id},'fixed',
          '2026-11-01','2027-10-31',${i ? 1 : 2},${i ? 'edit' : 'create'},${i ? 'direct' : 'application'},
          ${i ? 'approved' : 'in_review'},${i ? target : null},${i ? 1 : null},${w.session.user.id})`);
    }
    await tx.execute(sql`INSERT INTO approval_instances
      (tenant_id,process_id,version_id,approval_type,object_code,business_type,business_id,
        subject_employee_id,initiator_user_id,title,status,business_version,current_node_key)
      SELECT ${tenantId},p.id,v.id,'contract_create','TenantBase.EmploymentContract','contract',${ids[0]},
        ${w.employee.id},${w.session.user.id},'旧审批中记录','running','revision:1','owner'
      FROM approval_processes p JOIN approval_process_versions v ON v.process_id=p.id AND v.tenant_id=p.tenant_id
      WHERE p.tenant_id=${tenantId} AND p.approval_type='contract_create' AND v.status='published'`);
    await tx.execute(sql`INSERT INTO approval_tasks
      (tenant_id,instance_id,seq,round,node_key,assignee_user_id,origin,status)
      SELECT ${tenantId},i.id,1,1,'owner',v.exception_admin_user_id,'exception_admin','pending'
      FROM approval_instances i JOIN approval_process_versions v ON v.tenant_id=i.tenant_id AND v.id=i.version_id
      WHERE i.business_id=${ids[0]}::uuid`);
  });
  await handle.migrate();
  const clock = () => new Date('2026-10-01T01:00:00Z');
  const identity = { tenant: tenantId, user: w.session.user.id };
  const api = tenantApi(handle.db, { clock });
  const endpoint = `/api/tenant/contracts/requests/${ids[0]}/cancel`;
  const denied = tenantApi(handle.db, {
    clock,
    authorize: (r) => !(r.action === 'object.button' && r.resource?.includes('withdraw')),
  });
  expect((await denied.request('POST', endpoint, { ...identity, ifMatch: 1, body: {} })).status).toBe(403);
  const hidden = tenantApi(handle.db, { clock, authorize: (r) => r.action !== 'data.scope.all' });
  expect((await hidden.request('POST', endpoint, { ...identity, ifMatch: 1, body: {} })).status).toBe(404);
  expect(await (await api.request('GET', '/api/tenant/contracts/failures', identity)).json()).toMatchObject({
    items: expect.arrayContaining(ids.map((id) => expect.objectContaining({ object_id: id, kind: 'quarantine' }))),
  });
  // 时间未到也可处理隔离待办；审批实例/任务关闭但不删除。
  const result = await api.request('POST', endpoint, { ...identity, ifMatch: 1, body: {} });
  expect(result.status, await result.clone().text()).toBe(200);
  await withTenant(handle.db, tenantId, async (tx) => {
    expect(
      rowsOf(await tx.execute(sql`SELECT status FROM approval_instances WHERE business_id=${ids[0]}::uuid`)),
    ).toEqual([{ status: 'cancelled' }]);
    expect(
      rowsOf(
        await tx.execute(sql`SELECT t.status FROM approval_tasks t JOIN approval_instances i
      ON i.tenant_id=t.tenant_id AND i.id=t.instance_id WHERE i.business_id=${ids[0]}::uuid`),
      ),
    ).toEqual([{ status: 'cancelled' }]);
    expect(
      rowsOf(
        await tx.execute(sql`SELECT event FROM approval_instance_logs l JOIN approval_instances i
      ON i.tenant_id=l.tenant_id AND i.id=l.instance_id WHERE i.business_id=${ids[0]}::uuid`),
      ),
    ).toContainEqual({ event: 'cancel' });
  });
  // 即使绕过调度器直接调用激活，也不可让剩余未来编辑获胜。
  await expect(
    withTenant(handle.db, tenantId, async (tx) =>
      applyRequest(
        tx,
        {
          tenantId,
          userId: w.session.user.id,
          timezone: 'Asia/Shanghai',
          now: new Date('2026-12-01T01:00:00Z'),
          commandId: randomUUID(),
          expectedRevision: 1,
        },
        await loadRequest(tx, tenantId, ids[1]!),
      ),
    ),
  ).rejects.toMatchObject({
    code: 'CONFLICT',
    details: { reason: 'CONTRACT_IN_FLIGHT_QUARANTINED' },
  });
});
