/**
 * AC-OA-25-pg ② ④（R2-T08 §4.1 锁序、§7.3 选单、§7.6 暂停）。
 * ② 执行开始 vs 部门 D 入职：两者排在组织设置锁（④）后面，恰一方先过——执行先过则入职 409，入职先过则执行照常，无死锁。
 * ④ 两张相交单按审批先后执行，不相交单可先执行；两个进程同时领取也不乱序。②只在真 PG 跑，④两种库都跑。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runOrgAdjustmentTenant } from '../../apps/api/src/modules/org-adjustment/execution-runner.js';
import { scheduleOrgAdjustmentExecution } from '../../apps/api/src/modules/org-adjustment/schedule.js';
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
import { withLoginEmail } from './AC-EMP-support.js';
import { orgPeopleWorld, TODAY } from './AC-ORG-people-support.js';
import { fakeExecutors, seedAdjustment, seedItem, tableRows } from './support/org-adjustment-execution.js';
import { queueBehind, type HeldLockSpec } from './support/pg-interleave.js';

const testDb = useTestDb();

async function interleaveWorld(label: string) {
  const db = testDb().db;
  const w = await orgPeopleWorld(db, label);
  const tenant = { id: w.tenant.id, timezone: w.tenant.timezone };
  let now = new Date(`${TODAY}T02:00:00.000Z`);
  const clock = () => now;
  const setNow = (iso: string) => (now = new Date(iso));
  async function scheduled(targetOrgId: string, approvedAt: string) {
    const adjustment = await seedAdjustment(db, tenant.id, {
      createdBy: w.user.id,
      subjectOrgId: targetOrgId,
      effectiveDate: TODAY,
      approvedAt,
    });
    const group = await seedItem(db, tenant.id, adjustment.id, { seq: 1, target_org_id: targetOrgId });
    await withTenant(db, tenant.id, (tx) =>
      scheduleOrgAdjustmentExecution(
        tx,
        { tenantId: tenant.id, userId: w.user.id, timezone: tenant.timezone, now, commandId: randomUUID() },
        adjustment.id,
      ),
    );
    return { id: adjustment.id, group };
  }
  return { w, db, tenant, clock, setNow, scheduled };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-OA-25-pg ② 执行开始 vs 部门入职', () => {
  it.each(['runner-first', 'hire-first'] as const)('%s：恰一方先过组织设置锁，无死锁', async (order) => {
    const world = await interleaveWorld(`oa25-${order}`);
    const { w, db, tenant } = world;
    const d = await w.org('部门D');
    const adjustment = await world.scheduled(d.id, '2026-09-30T00:00:00.000Z');
    const newcomer = await w.employee('交错新人');
    const { calls, executors } = fakeExecutors();
    const runner = () => runOrgAdjustmentTenant(db, tenant, world.clock, { holderToken: 'process-a', executors });
    const hire = () =>
      w.request('POST', `/employees/${newcomer.id}/businesses`, {
        ifMatch: newcomer.revision,
        body: withLoginEmail(newcomer.id, {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: TODAY,
          fields: { employType: 'internal', departmentId: d.id },
        }),
      });
    const settings: HeldLockSpec = {
      run: (fn) => withTenant(db, tenant.id, fn),
      take: (tx) => lockOrganizationSettings(tx, tenant.id),
    };
    const settled = await queueBehind(settings, db, order === 'runner-first' ? [runner, hire] : [hire, runner]);
    const [runResult, hireResult] = order === 'runner-first' ? settled : [settled[1], settled[0]];
    expect(runResult!.status, '执行无死锁').toBe('fulfilled');
    expect(hireResult!.status, '入职无死锁').toBe('fulfilled');
    expect((runResult as PromiseFulfilledResult<{ completed: string[] }>).value.completed).toEqual([adjustment.id]);
    expect(calls).toEqual([adjustment.group]);
    const response = (hireResult as PromiseFulfilledResult<Response>).value;
    const text = await response.text();
    if (order === 'runner-first') {
      expect(response.status, text).toBe(409);
      expect(text).toContain('ORG_ADJUSTMENT_EXECUTING');
    } else expect(response.status, text).toBe(201);
    expect(await tableRows(db, tenant.id, 'org_adjustment_pauses', adjustment.id), '暂停已解除').toEqual([]);
  });
});

describe('AC-OA-25 ④ 相交单按审批先后，不相交单可先执行', () => {
  it('更早审批的相交单未到期时后单等待，不相交单先执行；到期后按审批先后执行，双进程同时领取不乱序', async () => {
    const world = await interleaveWorld('oa25-order');
    const { w, db, tenant } = world;
    const x = await w.org('相交组织X');
    const y = await w.org('独立组织Y');
    const first = await world.scheduled(x.id, '2026-09-28T00:00:00.000Z');
    const second = await world.scheduled(x.id, '2026-09-29T00:00:00.000Z');
    const disjoint = await world.scheduled(y.id, '2026-09-30T00:00:00.000Z');
    // 模拟大数据量单：排到次日 03:00（与 AC-OA-06 的数据量规则一致，这里直接改排期以免造 6000 行）
    await withTenant(db, tenant.id, (tx) =>
      tx.execute(sql`UPDATE org_adjustment_executions SET run_on_date='2026-10-02', run_from_hour=3
        WHERE tenant_id=${tenant.id} AND adjustment_id=${first.id}`),
    );

    const today = fakeExecutors();
    const run = (token: string, executors = today.executors) =>
      runOrgAdjustmentTenant(db, tenant, world.clock, { holderToken: token, executors });
    expect((await run('process-a')).completed).toEqual([disjoint.id]);
    expect(today.calls).toEqual([disjoint.group]);

    world.setNow('2026-10-01T19:00:00.000Z'); // 上海 10-02 03:00
    const a = fakeExecutors();
    const b = fakeExecutors();
    const results = await Promise.all([run('process-a', a.executors), run('process-b', b.executors)]);
    expect(results.flatMap((result) => result.completed)).toEqual([first.id, second.id]);
    expect([...a.calls, ...b.calls]).toEqual([first.group, second.group]);
  });
});
