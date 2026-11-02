/**
 * AC-OA-25-pg ① ③（R2-T08 §4.1 锁序、§7.5、§7.6；只在真 PG 跑）：两方都排在组织设置锁后面，按先后各验一次，无死锁。
 * ① 执行（改上级选“是”含员工 E）vs E 的调动：执行先过 → 调动 409；调动先落在 E 之后 → 执行时 E 记逐员工失败、其余人照常。
 *   调动经员工业务直接入口（与审批通过落地同一写入口与暂停判定，见 PR 描述“偏离”）。
 * ③ 执行 vs 直接改同一组织：执行先过 → 直接改 409；直接改先过 → 该组 ORG_ADJUSTMENT_BASELINE_CHANGED，不覆盖。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
import { E, type ExecWorld, execWorld } from './AC-OA-exec-support.js';
import { rename } from './AC-OA-items-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { queueBehind, type HeldLockSpec } from './support/pg-interleave.js';

const testDb = useTestDb();
type Order = 'runner-first' | 'other-first';

const settings = (w: ExecWorld): HeldLockSpec => ({
  run: (fn) => withTenant(w.db, w.tenant.id, fn),
  take: (tx) => lockOrganizationSettings(tx, w.tenant.id),
});

async function race(w: ExecWorld, order: Order, other: () => Promise<Response>) {
  const runner = () => w.run();
  const settled = await queueBehind(settings(w), w.db, order === 'runner-first' ? [runner, other] : [other, runner]);
  const [run, write] = order === 'runner-first' ? settled : [settled[1]!, settled[0]!];
  expect(run!.status, '执行无死锁').toBe('fulfilled');
  expect(write!.status, '对方无死锁').toBe('fulfilled');
  return (write as PromiseFulfilledResult<Response>).value;
}

const employeeRevision = (w: ExecWorld, employeeId: string) =>
  withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = resultRows<{ revision: number }>(
      await tx.execute(sql`SELECT revision FROM employment_employees WHERE id=${employeeId}`),
    );
    return row!.revision;
  });

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-OA-25-pg ① 执行 vs 员工调动', () => {
  it.each(['runner-first', 'other-first'] as const)('%s', async (order) => {
    const w = await execWorld(testDb().db, `oa25-1-${order}`);
    const x = await w.org('ZZ_交错X', w.a);
    const [mover, stayer] = [await w.staff(x), await w.staff(x)];
    const adjustment = await w.approved(
      [w.a, w.b],
      [rename(x, { name: undefined, parent: { orgId: w.b }, addEmployment: true })],
    );
    const transfer = async () =>
      w.call('POST', `/api/tenant/employment/employees/${mover}/businesses`, {
        ifMatch: await employeeRevision(w, mover),
        body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-02', fields: { departmentId: w.b } },
      });

    const response = await race(w, order, transfer);

    const text = await response.text();
    const [row] = [...(await w.outcomes(adjustment.id)).values()];
    const added = async (id: string) => (await w.records(id)).filter((r) => r.kind === 'org_adjustment');
    expect(await added(stayer)).toEqual([expect.objectContaining({ start_date: E, department_id: x })]);
    if (order === 'runner-first') {
      expect(response.status, text).toBe(409);
      expect(text).toContain('ORG_ADJUSTMENT_EXECUTING');
      expect(row).toMatchObject({ execution_result: 1, employment_done: 2 });
    } else {
      expect(response.status, text).toBe(201);
      expect(row).toMatchObject({ execution_result: 2, execution_reason: 'EMPLOYMENT_PARTIAL', employment_failed: 1 });
      expect((await w.failures(adjustment.id)).map((f) => f.employee_id)).toEqual([mover]);
      expect(await added(mover)).toEqual([]);
    }
    expect((await w.headRow(adjustment.id)).pauses).toBe(0);
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-OA-25-pg ③ 执行 vs 直接改同一组织', () => {
  it.each(['runner-first', 'other-first'] as const)('%s', async (order) => {
    const w = await execWorld(testDb().db, `oa25-3-${order}`);
    const x = await w.org('ZZ_交错改名', w.a);
    const adjustment = await w.approved([w.a], [rename(x, { name: 'ZZ_单据改名' })]);
    const revision = await w.orgRevision(x);
    const direct = () =>
      w.call('PATCH', `/api/tenant/org/organizations/${x}`, {
        ifMatch: revision,
        body: { name: 'ZZ_直接改名', effectiveDate: E, addEmployment: false },
      });

    const response = await race(w, order, direct);

    const text = await response.text();
    const [row] = [...(await w.outcomes(adjustment.id)).values()];
    if (order === 'runner-first') {
      expect(response.status, text).toBe(409);
      expect(text).toContain('ORG_ADJUSTMENT_EXECUTING');
      expect(row).toMatchObject({ execution_result: 1 });
      expect((await w.orgAt(x))!.name).toBe('ZZ_单据改名');
    } else {
      expect(response.status, text).toBe(200);
      expect(row).toMatchObject({ execution_result: 2, execution_reason: 'ORG_ADJUSTMENT_BASELINE_CHANGED' });
      expect((await w.orgAt(x))!.name).toBe('ZZ_直接改名');
    }
  });
});
