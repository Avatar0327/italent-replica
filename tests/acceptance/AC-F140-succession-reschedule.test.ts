/** DEC-689 / 690：真实离职 → 自动结束 → 人工改期；继任历史数据为合成夹具。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { registerEmployeeStatusHooks } from '../../apps/api/src/modules/employment/status-hooks.js';
import { lockTargets } from '../../apps/api/src/modules/succession/record-write.js';
import { waitForBlocked } from './support/pg-interleave.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { tenantApi } from './support/tenant-api.js';
import { exitWorld } from './AC-SC-02-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { exitActivator } from './AC-EXIT-activation-support.js';

const database = useTestDb();
async function fixture(label: string) {
  const w = await exitWorld(database().db, `f140b2-sc-${label}`);
  await installExitSeeds(database().db, w.tenant.id);
  const employee = await w.hire();
  const id = await w.seedRecord(employee.id);
  const leave = await w.leave(employee, '2026-10-15');
  await exitActivator(database().db, w)(leave.id, '2026-10-16');
  expect(await w.read(id)).toMatchObject({ end_date: '2026-10-16', exit_record_id: leave.id });
  w.setNow('2026-11-05T02:00:00Z');
  async function patch(lastWorkDate: string) {
    const get = await w.requestEmployment('GET', `/businesses/${leave.id}`);
    const current = await get.json();
    const response = await w.requestEmployment('PATCH', `/exits/${leave.id}`, {
      ifMatch: current.revision,
      body: { lastWorkDate },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }
  return { w, employee, id, leave, patch };
}

describe('F-140b2 继任结束日跟随', () => {
  it.each(['2026-10-25', '2026-10-10'])('改为 %s，完全跟随新生效日', async (last) => {
    const { w, id, patch } = await fixture(last);
    await patch(last);
    expect((await w.read(id)).end_date).toBe(last === '2026-10-25' ? '2026-10-26' : '2026-10-11');
  });

  it('人工修改过结束日仍按原离职台账覆盖', async () => {
    const { w, id, patch } = await fixture('manual');
    const before = await w.read(id);
    const edited = await tenantApi(database().db, { clock: () => new Date('2026-11-05T02:00:00Z') }).request(
      'PUT',
      `/api/tenant/succession/records/${id}`,
      {
        tenant: w.tenant.id,
        user: w.user.id,
        ifMatch: Number(before.revision),
        body: { endDate: '2026-10-18' },
      },
    );
    expect(edited.status, await edited.clone().text()).toBe(200);
    await patch('2026-10-25');
    expect((await w.read(id)).end_date).toBe('2026-10-26');
  });

  it.each([
    ['2026-10-25', true, '2026-10-30'],
    ['2026-10-19', false, '2026-10-30'],
    ['2026-10-25', true, '2026-10-20'],
  ] as const)('DEC-690：改至 %s，截断=%s（邻接结束 %s）', async (last, clipped, endDate) => {
    const { w, employee, id, patch } = await fixture(`clip-${last}`);
    const next = await w.seedRecord(employee.id, 'position', { startDate: '2026-10-20', endDate });
    const nextBefore = await w.read(next);
    const result = await patch(last);
    expect((await w.read(id)).end_date).toBe('2026-10-20');
    expect(await w.read(next)).toEqual(nextBefore);
    const hints = result.downstreamHints.items.filter((item: { kind: string }) => item.kind === 'succession');
    if (clipped)
      expect(hints).toEqual([
        expect.objectContaining({
          status: 'found',
          targets: [
            expect.objectContaining({
              id,
              detail: expect.objectContaining({
                expectedEndDate: '2026-10-26',
                actualEndDate: '2026-10-20',
                adjacentRecordId: next,
                message: '未能完全跟随、已截至下一条开始前，请人工核对',
              }),
            }),
          ],
        }),
      ]);
    else expect(hints).toEqual([]);
  });

  it('非本离职自动结束的记录不受影响', async () => {
    const { w, employee, id, patch } = await fixture('unrelated');
    const unrelated = await w.seedRecord(employee.id, 'org', { endDate: '2026-10-08' });
    const before = await w.read(unrelated);
    await patch('2026-10-25');
    expect((await w.read(id)).end_date).toBe('2026-10-26');
    expect(await w.read(unrelated)).toEqual(before);
  });
  it('订阅方存储失败时，已经执行的继任跟随和审计整体回滚', async () => {
    const { w, id, leave } = await fixture('rollback');
    const before = await w.read(id);
    registerEmployeeStatusHooks(`zz-f140b2-${id}`, {
      async onRecordRescheduled(_tx, _ctx, change) {
        if (change.before.recordId === leave.id) throw new Error('合成后续订阅失败');
      },
    });
    const current = await (await w.requestEmployment('GET', `/businesses/${leave.id}`)).json();
    const response = await w.requestEmployment('PATCH', `/exits/${leave.id}`, {
      ifMatch: current.revision,
      body: { lastWorkDate: '2026-10-25' },
    });
    expect(response.status).toBe(500);
    expect(await w.read(id)).toEqual(before);
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    'PG：并发新增先持目标锁，改期等锁后读取新邻接并截断成功',
    async () => {
      const { w, id, employee, patch } = await fixture('concurrent-next');
      let held!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        held = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const nextId = randomUUID();
      const holder = w.asTenant(async (tx) => {
        await lockTargets(tx, w.tenant.id, [{ kind: 'position', id: w.targetPosition.id }]);
        held();
        await released;
        await tx.execute(sql`INSERT INTO succession_records
        (id,tenant_id,succession_type,target_position_id,successor_employee_id,
          start_date,end_date,created_by,updated_by)
        VALUES (${nextId}::uuid,${w.tenant.id}::uuid,'position',${w.targetPosition.id}::uuid,
          ${employee.id}::uuid,'2026-10-20','2026-10-30',${w.user.id}::uuid,${w.user.id}::uuid)`);
      });
      await ready;
      const changing = patch('2026-10-25');
      try {
        await waitForBlocked(database().db, 1);
      } finally {
        release();
      }
      await holder;
      const result = await changing;
      expect((await w.read(id)).end_date).toBe('2026-10-20');
      expect(JSON.stringify(result.downstreamHints)).toContain(nextId);
    },
  );
});
