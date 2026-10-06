/**
 * AC-TRF-31（R1-T10 段）/ DEC-052 / DEC-183：到期生效时联动整单不执行、记 failed 待重试；
 * DEC-178（F-015 未合并前按 DEC-084）：联动改写碰到操作人范围外记录整单拒绝。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '@italent/api';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { tenantApi } from './support/tenant-api.js';
import { seedLegacyOrgDeactivation } from './AC-TRF-activation-support.js';
import { D, linkageWorld, type LinkageWorld } from './AC-LNK-support.js';

const database = useTestDb();

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

async function contractInstance(w: LinkageWorld) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const [row] = rows<{ id: string; revision: number }>(
      await tx.execute(sql`SELECT id, revision FROM approval_instances
        WHERE tenant_id=${w.session.tenant.id} AND business_type='contract' AND status='running' LIMIT 1`),
    );
    return row!;
  });
}

describe('AC-TRF-31 联动段：DEC-183 到期时遇在途合同整单不执行', () => {
  it('记 failed 与待办，合同、职责、试岗、提醒都不落地；处理在途合同后重试，联动按实际执行日一并执行（DEC-186）', async () => {
    const w = await linkageWorld(database().db, 'lnk-trf31');
    const person = await w.hire('到期冲突员工');
    const subordinate = await w.hire('下属', { directManagerId: person.employee.id });
    const receiver = await w.hire('接收人');
    const current = await w.contract(person.employee.id);
    const business = await w.saved(
      await w.transfer(person, {
        linkage: {
          contract: { targetId: current.id },
          adjustSalary: true,
          onTrial: { months: 2 },
          dutyTransfer: {
            subordinates: [
              { employeeId: subordinate.employee.id, receiverId: receiver.employee.id, relation: 'direct' },
            ],
          },
        },
      }),
    );
    await w.approve(business, '2026-10-02T01:00:00Z');
    // 审批通过后才出现的同类型在途合同（审批中）：保存时拦不住，只能在到期时拦。
    await w.contract(person.employee.id, { effectiveDate: '2026-12-01', endDate: '2027-11-30' }, 'application');

    const run = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(run).toMatchObject({ activated: [], failed: [business.id], errors: [] });
    const failed = await w.business(business.id);
    expect(failed.status).toBe('approved');
    expect(failed.activation).toMatchObject({ status: 'failed', failureCount: 1, failureReason: 'RULE_REJECTED' });
    const attempts = (await w.auditEvents(business.id)).filter((e) => e.action === 'employment.activation.failed');
    expect(attempts.at(-1)!.after).toMatchObject({ detail: { rule: 'TRANSFER_CONTRACT_IN_FLIGHT' } });
    const view = await w.linkage(business.id);
    expect(view).toMatchObject({
      executedAt: null,
      contract: null,
      onTrial: null,
      salaryReminder: null,
      dutyTransfer: null,
    });
    expect((await w.contracts(person.employee.id)).filter((c) => c.status === 'valid')).toHaveLength(1);
    expect(await w.managerOf(subordinate.hire.id)).toBe(person.employee.id);
    expect((await w.todos()).map((t) => t.id)).toContain(business.id);
    // 定时任务不自动重试失败单（DEC-052）。
    expect((await w.runScheduler('2026-10-10T02:00:00Z')).failed).toEqual([]);

    // HR 先处理在途合同（撤回审批中的合同申请），再重试。
    const instance = await contractInstance(w);
    const withdrawn = await w.api.request('POST', `/api/tenant/approval/instances/${instance.id}/withdraw`, {
      ...w.as,
      ifMatch: instance.revision,
      body: {},
    });
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    const beforeRetry = await w.business(business.id);
    const retried = await w.retry(business, '2026-10-11T02:00:00Z', 'lnk-trf31-retry');
    expect(retried.status, await retried.clone().text()).toBe(200);
    const done = await w.linkage(business.id);
    expect(done.contract).not.toBeNull();
    expect(done.onTrial).toMatchObject({ startDate: '2026-10-11' });
    expect(done.salaryReminder).toMatchObject({ status: 'pending' });
    expect(done.dutyTransfer).toMatchObject({ total: 1, failedCount: 0 });
    const contracts = await w.contracts(person.employee.id);
    expect(contracts.find((c) => c.previousContractId === current.id)).toMatchObject({ effectiveDate: '2026-10-11' });
    expect(await w.managerOf(subordinate.hire.id)).toBe(receiver.employee.id);
    expect(await w.todos()).toEqual([]);
    // 同一幂等键重放不重复执行；新键重试 409（已生效）。
    const replay = await w.session.request('POST', `/businesses/${business.id}/activation/retry`, {
      ifMatch: beforeRetry.revision,
      body: {},
      idempotencyKey: 'lnk-trf31-retry',
    });
    expect(replay.status).toBe(200);
    expect(await w.contracts(person.employee.id)).toHaveLength(contracts.length);
    expect((await w.retry(business, '2026-10-11T03:00:00Z')).status).toBe(409);
  });

  it('主记录校验失败（调入部门停用）时联动同样整单不执行', async () => {
    const w = await linkageWorld(database().db, 'lnk-trf31-org');
    const person = await w.hire('部门停用员工');
    const business = await w.saved(
      await w.transfer(person, { linkage: { adjustSalary: true, onTrial: { months: 1 } } }),
    );
    await w.approve(business, '2026-10-02T01:00:00Z');
    // DEC-196：正常入口已拦截在途调入，只构造历史遗留状态验证 DEC-052 联动失败兜底。
    await seedLegacyOrgDeactivation(w, D);
    const run = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(run.failed).toEqual([business.id]);
    expect(await w.linkage(business.id)).toMatchObject({ executedAt: null, onTrial: null, salaryReminder: null });
  });
});

describe('DEC-178 / DEC-084 联动改写碰到操作人范围外记录', () => {
  function scopedApi(w: LinkageWorld, orgIds: string[]) {
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async () => ({
        ...EMPTY_SCOPE,
        orgIds,
        hasDataPermission: true,
        terms: [{ dimension: 'organization' as const, orgIds, personIds: [] }],
      }),
      authorize: async () => true,
      fields: async () => new Set(['id', 'revision', 'status']),
    });
    const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00Z') });
    return (method: string, path: string, body: object, ifMatch: number) =>
      api.request(method, `/api/tenant/employment${path}`, { ...w.as, ifMatch, body });
  }

  it('转交的下属任职在操作人范围外：保存整单拒绝（LINKED_RECORD_OUT_OF_SCOPE），不留下调动', async () => {
    const w = await linkageWorld(database().db, 'lnk-scope');
    const outside = await w.session.org('范围外部门', { establishedOn: '2026-01-01' });
    const person = await w.hire('范围内调动人');
    const subordinate = await w.hire('范围外下属', { directManagerId: person.employee.id }, outside.id);
    const receiver = await w.hire('接收人');
    const request = scopedApi(w, [w.from.id, w.to.id]);
    const employee = await w.session.getEmployee(person.employee.id);
    const response = await request(
      'POST',
      `/transfers/employees/${person.employee.id}`,
      {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'application',
        submit: false,
        effectiveDate: D,
        fields: { departmentId: w.to.id },
        linkage: {
          dutyTransfer: {
            subordinates: [
              { employeeId: subordinate.employee.id, receiverId: receiver.employee.id, relation: 'direct' },
            ],
          },
        },
      },
      employee.revision,
    );
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'LINKED_RECORD_OUT_OF_SCOPE' } });
    expect((await w.session.getEmployee(person.employee.id)).revision).toBe(employee.revision);
  });

  it('失败子项由范围外的操作人重试：整单拒绝，子项状态不变', async () => {
    const w = await linkageWorld(database().db, 'lnk-scope-retry');
    const outside = await w.session.org('范围外部门', { establishedOn: '2026-01-01' });
    const person = await w.hire('调动人');
    const subordinate = await w.hire('范围外下属', { directManagerId: person.employee.id }, outside.id);
    const receiver = await w.hire('接收人', { directManagerId: subordinate.employee.id });
    const business = await w.saved(
      await w.transfer(person, {
        linkage: {
          dutyTransfer: {
            subordinates: [
              { employeeId: subordinate.employee.id, receiverId: receiver.employee.id, relation: 'direct' },
            ],
          },
        },
      }),
    );
    await w.approve(business, '2026-10-02T01:00:00Z');
    await w.runScheduler('2026-10-10T01:00:00Z');
    const [item] = (await w.linkage(business.id)).dutyTransfer!.items;
    expect(item).toMatchObject({ status: 'failed', attemptCount: 1 });
    const request = scopedApi(w, [w.from.id, w.to.id]);
    const response = await request('POST', `/transfers/linkage-items/${item!.id}/retry`, {}, item!.revision);
    expect(response.status).toBe(404);
    expect((await w.linkage(business.id)).dutyTransfer!.items[0]).toMatchObject({ status: 'failed', attemptCount: 1 });
  });
});
