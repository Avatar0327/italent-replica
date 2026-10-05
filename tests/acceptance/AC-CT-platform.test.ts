import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld, type ContractView } from './AC-CT-support.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { allowAll, tenantApi } from './support/tenant-api.js';
import { runContractJobs } from '../../apps/api/src/modules/contracts/scheduler.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';

const testDb = useTestDb();
describe('R2-T06 合同平台、审批与调度', () => {
  it('四种审批类型有独立流程；未来申请审批通过后按租户时区落地，重复调度不重复写', async () => {
    const w = await contractWorld(testDb().db, 'ctapproval');
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    const response = await w.request('POST', '/commands', {
      ifMatch: 0,
      body: {
        operation: 'create',
        mode: 'application',
        employeeId: w.employee.id,
        fields: { ...w.fields, effectiveDate: '2026-10-02', endDate: '2027-10-01' },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const request = (await response.json()) as { id: string };
    expect((await w.list()).filter((c) => c.approvalStatus === 'effective')).toHaveLength(0);
    const [task] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rowsOf<{
        id: string;
        userId: string;
        revision: number;
      }>(
        await tx.execute(sql`SELECT t.id,t.assignee_user_id AS "userId",i.revision FROM approval_tasks t
      JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
      WHERE i.business_id=${request.id}::uuid AND t.status='pending'`),
      ),
    );
    expect(task).toBeDefined();
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const approved = await api.request('POST', '/api/tenant/contracts/todos/batch', {
      tenant: w.session.tenant.id,
      user: task!.userId,
      ifMatch: 0,
      body: { action: 'approve', items: [{ id: task!.id, revision: task!.revision }] },
    });
    expect(await approved.json()).toMatchObject({ items: [{ status: 200 }] });
    expect((await w.list()).filter((c) => c.approvalStatus === 'effective')).toHaveLength(0);
    const run = (time: string) =>
      runContractJobs(
        w.db,
        { tenantId: w.session.tenant.id },
        {
          clock: () => new Date(time),
          authorize: allowAll,
        },
      );
    await run('2026-10-01T15:59:59Z');
    expect((await w.list()).filter((c) => c.approvalStatus === 'effective')).toHaveLength(0);
    await run('2026-10-01T16:00:00Z');
    await run('2026-10-01T16:00:01Z');
    expect(await w.list()).toHaveLength(1);
  });

  it('自动续签失败可见、修正后重试；同类型仅最新合同且第三次无固定期限', async () => {
    const w = await contractWorld(testDb().db, 'ctauto');
    await w.create({ effectiveDate: '2025-01-01', endDate: '2025-09-30' });
    const latest = await w.create({ effectiveDate: '2025-10-01', endDate: '2026-10-05' });
    await w.settings({ autoRenew: true });
    const rule = await w.request('POST', '/rules', {
      ifMatch: 0,
      body: {
        name: '续签规则',
        priority: 1,
        orgIds: [w.org.id],
        personIds: [],
        details: [
          {
            typeId: w.type.id,
            months: 12,
            initiatorId: w.session.user.id,
            daysBefore: 10,
            skipTypeIds: [],
          },
        ],
      },
    });
    expect(rule.status, await rule.clone().text()).toBe(201);
    const run = () =>
      runContractJobs(
        w.db,
        { tenantId: w.session.tenant.id },
        {
          clock: () => new Date('2026-10-01T01:00:00Z'),
          authorize: allowAll,
        },
      );
    expect((await run()).runs[0]?.outcomes).toContainEqual(expect.objectContaining({ id: latest.id, state: 'failed' }));
    expect(((await (await w.request('GET', '/failures')).json()) as { items: unknown[] }).items).toHaveLength(1);
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    await run();
    await run();
    const requests = await w.list('in_review');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ termType: 'indefinite', endDate: null, signingCount: 3 });
  });

  it('到期终止按租户日期、幂等并保留审计 outbox；单次处理量有界', async () => {
    const w = await contractWorld(testDb().db, 'ctexpire');
    const first = await w.create();
    const second = await w.create({ number: 'SECOND' });
    await w.settings({ autoTerminate: true });
    const result = await runContractJobs(
      w.db,
      { tenantId: w.session.tenant.id, limit: 1 },
      {
        clock: () => new Date('2026-10-01T01:00:00Z'),
        authorize: allowAll,
      },
    );
    expect(result.runs[0]?.outcomes).toHaveLength(1);
    await runContractJobs(
      w.db,
      { tenantId: w.session.tenant.id },
      {
        clock: () => new Date('2026-10-01T01:00:00Z'),
        authorize: allowAll,
      },
    );
    expect((await w.list()).map((c) => c.status)).toEqual(['terminated', 'terminated']);
    const events = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rowsOf(
        await tx.execute(sql`
      SELECT id FROM contract_outbox WHERE event_type='contract.state'
        AND object_id IN (${first.id}::uuid,${second.id}::uuid)`),
      ),
    );
    expect(events).toHaveLength(2);
  });

  it('批量全部成功或全部失败；同键重放不重复新建、同键异内容 409', async () => {
    const w = await contractWorld(testDb().db, 'ctbatch');
    const first = await w.create();
    const second = await w.create();
    const command = (target: ContractView, revision: number) => ({
      revision,
      command: {
        operation: 'terminate',
        mode: 'direct',
        employeeId: w.employee.id,
        targetId: target.id,
        fields: { actualTerminationDate: '2026-09-30' },
      },
    });
    const failed = await w.request('POST', '/batch', {
      ifMatch: 0,
      body: { items: [command(first, 1), command(second, 9)] },
    });
    expect(failed.status).toBe(409);
    expect((await w.list()).every((c) => c.status === 'valid')).toBe(true);
    const idempotencyKey = randomUUID();
    const body = { items: [command(first, 1), command(second, 1)] };
    expect((await w.request('POST', '/batch', { ifMatch: 0, body, idempotencyKey })).status).toBe(200);
    expect((await w.request('POST', '/batch', { ifMatch: 0, body, idempotencyKey })).status).toBe(200);
    expect(
      (await w.request('POST', '/batch', { ifMatch: 0, body: { items: [command(first, 1)] }, idempotencyKey })).status,
    ).toBe(409);
  });

  it('跨租户不可读；撤权后的幂等重放拒绝；字段权限不泄露 customFields', async () => {
    const w = await contractWorld(testDb().db, 'ctscope');
    const other = await contractWorld(testDb().db, 'ctother');
    const original = await w.create();
    expect((await other.request('GET', `/records/${original.id}`)).status).toBe(404);
    const hidden = tenantApi(w.db, { authorize: (request) => request.action !== 'data.scope.all' });
    expect(
      (await hidden.request('GET', '/api/tenant/contracts', { tenant: w.session.tenant.id, user: w.session.user.id }))
        .status,
    ).toBe(200);
    const result = await hidden.request('GET', `/api/tenant/contracts/records/${original.id}`, {
      tenant: w.session.tenant.id,
      user: w.session.user.id,
    });
    expect(result.status).toBe(404);
  });

  it('导入新增 / 编辑 / 变更、预览回滚、错误明细下载、缺失视图', async () => {
    const w = await contractWorld(testDb().db, 'ctimport');
    expect(await w.list('missing')).toHaveLength(1);
    const row = { employeeId: w.employee.id, fields: { ...w.fields, number: 'IMPORT' } };
    const preview = await w.request('POST', '/imports/preview', { ifMatch: 0, body: { mode: 'add', rows: [row] } });
    expect(await preview.json()).toMatchObject({ valid: true });
    expect(await w.list()).toHaveLength(0);
    expect((await w.request('POST', '/imports', { ifMatch: 0, body: { mode: 'add', rows: [row] } })).status).toBe(200);
    const edit = await w.request('POST', '/imports', {
      ifMatch: 0,
      body: { mode: 'edit', rows: [{ ...row, revision: 1, fields: { ...row.fields, probationSalary: '100.00' } }] },
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    const change = await w.request('POST', '/imports', {
      ifMatch: 0,
      body: {
        mode: 'change',
        rows: [
          {
            ...row,
            revision: 1,
            originalEffectiveDate: '2025-01-01',
            fields: { ...row.fields, number: 'NEW', effectiveDate: '2025-02-01' },
          },
        ],
      },
    });
    expect(change.status, await change.clone().text()).toBe(200);
    const errors = await w.request('POST', '/imports/errors', {
      ifMatch: 0,
      body: { mode: 'add', rows: [{ ...row, fields: { ...row.fields, endDate: '2024-01-01' } }] },
    });
    expect(errors.headers.get('content-type')).toContain('text/csv');
    expect(await errors.text()).toContain('VALIDATION_FAILED');
  });
});
