/**
 * BE-2a 第 1 轮审查返工（#358，Codex Sol high）：
 * ① 改期必须按 { effectiveDate } 校验字段写权限；② 改期保留重聘 / 退休返聘的业务类型。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  addHire,
  addPending,
  businessRevision,
  entryAction,
  entryRecords,
  entryWorld,
  hireBody,
} from './AC-EN-BE2a-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
// 非默认表单标识：改期重建业务时 formId 必须原样保留（审查 #358 第 2 轮 P3）
const FORM_ID = 'campus-hire';

async function counts(w: Awaited<ReturnType<typeof entryWorld>>) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT
      (SELECT count(*)::int FROM audit_events WHERE tenant_id=${w.session.tenant.id}) AS audit,
      (SELECT count(*)::int FROM command_ledger WHERE tenant_id=${w.session.tenant.id}) AS ledger,
      (SELECT count(*)::int FROM employment_entry_actions WHERE tenant_id=${w.session.tenant.id}) AS actions`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0] as Record<string, number>;
  });
}

describe('BE-2a 第 1 轮返工 P2-1：改期的字段写权限', () => {
  it('没有 effectiveDate 写权限：403，原待入职、审计、命令台账、日志都不变；有权限的人照常改期', async () => {
    const w = await entryWorld(testDb().db, 'be2a-r2-perm');
    const { employee, recordId } = await addPending(w, '2026-10-10');
    const before = await counts(w);
    const denied = tenantApi(w.db, {
      clock: () => new Date('2026-10-01T01:00:00.000Z'),
      authorize: (request) => !(request.action === 'object.update' && request.fields?.includes('effectiveDate')),
    });
    const response = await denied.request('POST', `/api/tenant/employment/pending-entries/${recordId}/postpone`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: await businessRevision(w, recordId),
      idempotencyKey: randomUUID(),
      body: { effectiveDate: '2026-10-20', remark: '无权改日期' },
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await counts(w)).toEqual(before);
    const [record] = await entryRecords(w, employee.id);
    expect(record).toMatchObject({ id: recordId, effectiveDate: '2026-10-10', entryStatus: 0 });
    const allowed = await entryAction(w, recordId, 'postpone', { effectiveDate: '2026-10-20' });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
  });
});

describe('BE-2a 第 1 轮返工 P2-2：改期保留业务类型', () => {
  it.each([
    ['rehire', 'leave'],
    ['retire_rehire', 'retirement'],
  ] as const)('%s 待入职改期后仍是 %s（业务、任职记录、任职周期）', async (kind, ending) => {
    const w = await entryWorld(testDb().db, `be2a-r2-${kind}`);
    const employee = await w.session.employee('重聘合成员工');
    const hired = await w.session.business(employee.id, hireBody(w.org.id, '2026-01-05'), employee.revision);
    const left = await w.session.business(
      employee.id,
      { kind: ending, mode: 'direct', lastWorkDate: '2026-03-31', fields: {} },
      hired.employeeRevision,
    );
    const response = await addHire(
      w.session,
      { id: employee.id, revision: left.employeeRevision },
      { ...hireBody(w.org.id, '2026-10-10', { pendingEntry: true }), kind, formId: FORM_ID },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const pending = (await response.json()) as { id: string };
    const postponed = await entryAction(w, pending.id, 'postpone', { effectiveDate: '2026-10-20' });
    expect(postponed.status, await postponed.clone().text()).toBe(200);
    const body = (await postponed.json()) as { id: string; kind: string; record: { kind: string } };
    expect(body).toMatchObject({ kind, formId: FORM_ID, record: { kind } });
    const cycle = await withTenant(w.db, w.session.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT entry_type AS "entryType" FROM employment_cycles
        WHERE tenant_id=${w.session.tenant.id} AND employee_id=${employee.id}::uuid ORDER BY entry_date DESC LIMIT 1`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0];
    });
    expect(cycle).toEqual({ entryType: kind });
    expect((await entryRecords(w, employee.id)).at(-1)).toMatchObject({ kind, effectiveDate: '2026-10-20' });
  });
});
