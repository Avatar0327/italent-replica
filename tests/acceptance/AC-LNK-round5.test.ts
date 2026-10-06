/**
 * PR #74 第五轮（astra 第四轮审查 P2）：调动合同变更的在途判定复用合同模块 F-016 的统一判定（DEC-180② / DEC-183）。
 * 普通退回的申请不算在途；带隔离记录的退回、审批中、批准未生效算在途。提交、修改联动、生效三个阶段口径一致，
 * 拒绝详情只给调动的机读原因，不带合同申请标识。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { linkageWorld, type LinkageWorld } from './AC-LNK-support.js';

const database = useTestDb();

type Pending = 'returned' | 'quarantined' | 'in_review' | 'approved';
const CASES: { name: string; state: Pending; blocked: boolean }[] = [
  { name: '普通退回的申请', state: 'returned', blocked: false },
  { name: '带隔离记录的退回申请', state: 'quarantined', blocked: true },
  { name: '审批中的申请', state: 'in_review', blocked: true },
  { name: '批准但未生效的申请', state: 'approved', blocked: true },
];

/** 同类型、未来生效的合同申请，再按场景把状态调到退回 / 隔离 / 批准未生效。 */
async function pendingContract(w: LinkageWorld, employeeId: string, state: Pending) {
  await w.contract(employeeId, { effectiveDate: '2026-12-01', endDate: '2027-11-30', termMonths: 12 }, 'application');
  await withTenant(w.db, w.session.tenant.id, async (tx) => {
    const tenant = w.session.tenant.id;
    const rows = await tx.execute(sql`SELECT id FROM contract_requests WHERE tenant_id=${tenant}
      AND employee_id=${employeeId}::uuid AND effective_date='2026-12-01' AND status='in_review'`);
    const [request] = (Array.isArray(rows) ? rows : (rows as { rows: { id: string }[] }).rows) as { id: string }[];
    expect(request).toBeTruthy();
    const status = state === 'quarantined' ? 'returned' : state;
    await tx.execute(sql`UPDATE contract_requests SET status=${status} WHERE id=${request!.id}::uuid`);
    if (state === 'quarantined')
      await tx.execute(sql`INSERT INTO contract_job_attempts
        (tenant_id, object_id, employee_id, kind, state, error, command_id)
        VALUES (${tenant}, ${request!.id}::uuid, ${employeeId}::uuid, 'quarantine', 'failed',
          'CONTRACT_IN_FLIGHT_QUARANTINED', ${randomUUID()})`);
  });
}

async function expectBlocked(response: Response) {
  expect(response.status, await response.clone().text()).toBe(409);
  const body = (await response.json()) as { error: { details: Record<string, unknown> } };
  expect(body.error.details).toEqual({ reason: 'TRANSFER_CONTRACT_IN_FLIGHT' });
}

describe.each(CASES)('$name（在途：$blocked）', ({ state, blocked }) => {
  it('提交阶段', async () => {
    const w = await linkageWorld(database().db, `lnk5-submit-${state}`);
    const person = await w.hire('提交员工');
    const current = await w.contract(person.employee.id);
    const draft = await w.saved(
      await w.transfer(person, { submit: false, linkage: { contract: { targetId: current.id } } }),
    );
    await pendingContract(w, person.employee.id, state);
    const submit = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    if (blocked) await expectBlocked(submit);
    else expect(submit.status, await submit.clone().text()).toBe(200);
  });

  it('修改联动阶段', async () => {
    const w = await linkageWorld(database().db, `lnk5-put-${state}`);
    const person = await w.hire('修改员工');
    const current = await w.contract(person.employee.id);
    const draft = await w.saved(await w.transfer(person, { submit: false, linkage: { adjustSalary: true } }));
    await pendingContract(w, person.employee.id, state);
    const put = await w.session.request('PUT', `/transfers/${draft.id}/linkage`, {
      ifMatch: draft.revision,
      body: { adjustSalary: true, contract: { targetId: current.id, fields: { endDate: '2030-01-01' } } },
    });
    if (blocked) await expectBlocked(put);
    else expect(put.status, await put.clone().text()).toBe(200);
  });

  it('生效阶段', async () => {
    const w = await linkageWorld(database().db, `lnk5-activate-${state}`);
    const person = await w.hire('生效员工');
    const current = await w.contract(person.employee.id);
    const business = await w.saved(await w.transfer(person, { linkage: { contract: { targetId: current.id } } }));
    await w.approve(business, '2026-10-02T01:00:00Z');
    await pendingContract(w, person.employee.id, state);
    await w.runScheduler('2026-10-10T01:00:00Z');
    const after = await w.business(business.id);
    if (blocked) {
      expect(after.status).toBe('approved');
      expect(after.activation).toMatchObject({ status: 'failed', failureReason: 'RULE_REJECTED' });
      const attempts = (await w.auditEvents(business.id)).filter((e) => e.action === 'employment.activation.failed');
      expect(attempts.at(-1)!.after).toMatchObject({ detail: { rule: 'TRANSFER_CONTRACT_IN_FLIGHT' } });
      expect(await w.contractChanges(person.employee.id)).toEqual([]);
    } else {
      expect(after.status).toBe('effective');
      expect(await w.contractChanges(person.employee.id)).toMatchObject([{ beforeContractId: current.id }]);
    }
  });
});
