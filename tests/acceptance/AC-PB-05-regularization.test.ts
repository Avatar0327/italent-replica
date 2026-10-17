/**
 * BE-3 转正（B7 / B8，docs/02_业务建模/29 PB-R7 / PB-R8，§4 AC-PB-05）：
 * 直接转正必填试用结果（转正日期不填取默认值，F-205）；批量可统一转正日期，单人失败不影响其他人、返回逐人结果；
 * 批量申请每人一条独立审批流程；转正生效后之后的调动记录也是正式。试用结果取租户字典（预置三项，可停用）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  employeeRevision,
  hire,
  pbWorld,
  probationOf,
  regularize,
  regularizeOk,
  type PbWorld,
} from './AC-PB-support.js';

const testDb = useTestDb();
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

async function results(w: PbWorld) {
  const response = await w.session.request('GET', '/probation-results');
  expect(response.status, await response.clone().text()).toBe(200);
  return (
    (await response.json()) as {
      items: { id: string; code: string; name: string; enabled: boolean; revision: number }[];
    }
  ).items;
}

describe('AC-PB-05 转正生效后向后更新人员状态', () => {
  it('员工有 12-01 的调动记录，11-01 转正生效 → 12-01 的调动记录也为正式', async () => {
    const w = await pbWorld(testDb().db, 'pb05-forward');
    const { employee } = await hire(w, { months: 3 });
    await w.session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-12-01', fields: { place: '调动地点' } },
      await employeeRevision(w, employee.id),
    );
    await regularizeOk(w, { mode: 'direct', effectiveDate: '2026-11-01' }, [employee.id]);
    const records = await w.session.records(employee.id, '2026-12-01');
    expect(records.map((r) => [r.kind, (r as unknown as { employeeStatus: number }).employeeStatus])).toEqual([
      ['hire', 2],
      ['regularization', 3],
      ['transfer', 3],
    ]);
  });
});

describe('B7 / B8 单个与批量转正（PB-R8）', () => {
  it('直接转正缺试用结果 400；试用结果不在字典里 400；停用后不能再选', async () => {
    const w = await pbWorld(testDb().db, 'pb-result');
    const { employee } = await hire(w, { months: 3 });
    const missing = await w.session.request('POST', '/regularizations', {
      body: { mode: 'direct', items: [{ employeeId: employee.id, revision: await employeeRevision(w, employee.id) }] },
    });
    expect(missing.status).toBe(400);
    const unknown = await regularize(w, { mode: 'direct', probationResult: 'unknown' }, [employee.id]);
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'PROBATION_RESULT_UNKNOWN',
    );
    const early = (await results(w)).find((item) => item.code === 'early')!;
    const disabled = await w.session.request('PUT', `/probation-results/${early.id}`, {
      ifMatch: early.revision,
      body: { enabled: false },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    expect((await regularize(w, { mode: 'direct', probationResult: 'early' }, [employee.id])).status).toBe(400);
  });

  it('试用结果字典：预置正常 / 提前 / 延期转正，租户可新增并选用', async () => {
    const w = await pbWorld(testDb().db, 'pb-result-dict');
    expect((await results(w)).map((item) => [item.code, item.name])).toEqual([
      ['normal', '正常转正'],
      ['early', '提前转正'],
      ['delayed', '延期转正'],
    ]);
    const created = await w.session.request('POST', '/probation-results', {
      ifMatch: 0,
      body: { code: 'excellent', name: '表现优秀', displayOrder: 40 },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const duplicate = await w.session.request('POST', '/probation-results', {
      ifMatch: 0,
      body: { code: 'EXCELLENT', name: '重复' },
    });
    expect(duplicate.status).toBe(409);
    const { employee } = await hire(w, { months: 3 });
    const receipt = await regularizeOk(w, { mode: 'direct', probationResult: 'excellent' }, [employee.id]);
    expect(receipt.items[0]!.status).toBe('succeeded');
    expect((await probationOf(w, employee.id, '2026-12-01')).probationResult).toBe('excellent');
  });

  it('批量直接转正：统一转正日期；一人失败（没有预计试用结束日、又没统一填日期）不影响其他人，返回逐人结果', async () => {
    const w = await pbWorld(testDb().db, 'pb-batch-direct');
    const a = await hire(w, { months: 3, name: '甲' });
    const b = await hire(w, { months: 2, name: '乙' });
    const noEnd = await hire(w, { name: '丙' });
    const unified = await regularizeOk(w, { mode: 'direct', effectiveDate: '2026-10-20' }, [
      a.employee.id,
      b.employee.id,
    ]);
    expect(unified).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
    expect(unified.items.map((item) => item.effectiveDate)).toEqual(['2026-10-20', '2026-10-20']);

    const c = await hire(w, { months: 1, name: '丁' });
    const mixed = await regularizeOk(w, { mode: 'direct' }, [c.employee.id, noEnd.employee.id]);
    expect(mixed).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect(mixed.items[0]).toMatchObject({
      employeeId: c.employee.id,
      status: 'succeeded',
      effectiveDate: '2026-10-01',
    });
    expect(mixed.items[1]).toMatchObject({ employeeId: noEnd.employee.id, status: 'failed', businessId: null });
    expect(mixed.items[1]!.error).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('员工 revision 过期只让这一人失败；同一人在一单内重复 → 整单 400', async () => {
    const w = await pbWorld(testDb().db, 'pb-batch-revision');
    const a = await hire(w, { months: 3, name: '甲' });
    const b = await hire(w, { months: 3, name: '乙' });
    const response = await w.session.request('POST', '/regularizations', {
      body: {
        mode: 'direct',
        probationResult: 'normal',
        items: [
          { employeeId: a.employee.id, revision: (await employeeRevision(w, a.employee.id)) - 1 },
          { employeeId: b.employee.id, revision: await employeeRevision(w, b.employee.id) },
        ],
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const receipt = (await response.json()) as { items: { status: string; error: { code: string } | null }[] };
    expect(receipt.items.map((item) => item.status)).toEqual(['failed', 'succeeded']);
    expect(receipt.items[0]!.error!.code).toBe('REVISION_CONFLICT');
    const duplicate = await w.session.request('POST', '/regularizations', {
      body: {
        mode: 'direct',
        probationResult: 'normal',
        items: [
          { employeeId: b.employee.id, revision: 1 },
          { employeeId: b.employee.id, revision: 1 },
        ],
      },
    });
    expect(duplicate.status).toBe(400);
  });

  it('批量转正申请：每人一张申请、各自发起一条审批流程，状态为审批中', async () => {
    const w = await pbWorld(testDb().db, 'pb-batch-apply', { approval: true });
    const a = await hire(w, { months: 3, name: '甲' });
    const b = await hire(w, { months: 1, name: '乙' });
    const receipt = await regularizeOk(w, { mode: 'application', probationResult: 'delayed' }, [
      a.employee.id,
      b.employee.id,
    ]);
    expect(receipt).toMatchObject({ succeeded: 2, failed: 0 });
    expect(receipt.items.map((item) => [item.effectiveDate, item.businessStatus])).toEqual([
      ['2026-12-01', 'in_review'],
      ['2026-10-01', 'in_review'],
    ]);
    const ids = receipt.items.map((item) => item.businessId!);
    const instances = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows<{ businessId: string }>(
        await tx.execute(sql`SELECT business_id::text AS "businessId" FROM approval_instances
          WHERE tenant_id=${w.session.tenant.id} AND business_type='employment' ORDER BY business_id`),
      ),
    );
    expect(instances.map((row) => row.businessId).sort()).toEqual([...ids].sort());
    expect((await probationOf(w, a.employee.id)).probationResult).toBe('delayed');
  });
});
