/** C2-1b：周期守卫、F-055 真实取数循环、DEC-032 终态补集。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { evaluationLeaveWorld, lockEvaluation, rowsOf } from './AC-EV-leave-support.js';
import { assertCycleActive } from '../../apps/api/src/modules/evaluation/cycle-guard.js';
import { runEvaluationLeave } from '../../apps/api/src/modules/evaluation/leave-handler.js';

const database = useTestDb();
const run = (w: Awaited<ReturnType<typeof evaluationLeaveWorld>>, at = '2026-10-22T08:00:00Z') =>
  runEvaluationLeave(w.db, w.tenantId, { clock: () => new Date(at) });

describe('AC-EV-leave-guard / DEC-032 / P2-04', () => {
  it.each(['leave', 'retirement'])(
    '%s 只终止同周期进行中，终态不动；生效日与处理时刻分离，重复消费不增加审计',
    async (kind) => {
      const w = await evaluationLeaveWorld(database().db);
      const states = [
        {},
        { apply_status: 'reviewing' },
        { material_status: 'failed' },
        { apply_status: 'failed' },
        { result_status: 'published' },
        { terminated_at: w.now.toISOString(), terminated_reason: 'revoked' },
      ];
      const ids: string[] = [];
      for (const state of states) ids.push(await w.seed(state));
      const other = await w.seed({}, w.f.mgrB.id);
      const before = await Promise.all([...ids, other].map(w.read));
      const leave = await w.leave('2026-10-20', w.f.mgrA.id, kind);
      expect(await run(w, '2026-10-20T15:59:59Z')).toMatchObject({ picked: 0 });
      expect(await w.read(ids[0]!)).toEqual(before[0]);
      expect(await run(w)).toMatchObject({ done: 1, failed: 0 });
      for (const id of ids.slice(0, 3)) {
        const row = await w.read(id);
        expect(row).toMatchObject({ revision: 2, terminated_reason: 'leave' });
        expect(new Date(row.terminated_at as string).toISOString()).toBe('2026-10-20T16:00:00.000Z');
        expect(new Date(row.updated_at as string).toISOString()).toBe('2026-10-22T08:00:00.000Z');
      }
      expect(await Promise.all([...ids.slice(3), other].map(w.read))).toEqual(before.slice(3));
      expect(await w.queue(leave.id)).toEqual([{ state: 'done', reason: null, attempts: 1 }]);
      expect(await run(w)).toMatchObject({ picked: 0 });
      await withTenant(w.db, w.tenantId, async (tx) => {
        expect(
          rowsOf(
            await tx.execute(sql`SELECT id FROM audit_events WHERE tenant_id=${w.tenantId}
        AND action='evaluation.staff-evaluation.terminate'`),
          ),
        ).toHaveLength(3);
        expect(
          rowsOf(await tx.execute(sql`SELECT id FROM ev_notifications WHERE tenant_id=${w.tenantId}`)),
        ).toHaveLength(3);
      });
    },
  );

  it('生效前删除：真实循环将事件标 skipped，进行中评定不变，守卫也不把历史离职当有效记录', async () => {
    const w = await evaluationLeaveWorld(database().db);
    const id = await w.seed();
    const before = await w.read(id);
    const leave = await w.leave();
    await w.remove(leave);
    expect(await run(w, '2026-10-10T08:00:00Z')).toMatchObject({ skipped: 1, done: 0 });
    expect(await w.queue(leave.id)).toEqual([{ state: 'skipped', reason: 'RECORD_NOT_EFFECTIVE', attempts: 1 }]);
    expect(await w.read(id)).toEqual(before);
    await withTenant(w.db, w.tenantId, (tx) => assertCycleActive(tx, w.ctx(), before.cycle_id as string));
  });

  it('写守卫按租户今天与固定周期判断；消费者尚未运行已拒绝，重聘的新周期可写、旧周期仍拒绝', async () => {
    const w = await evaluationLeaveWorld(database().db);
    const id = await w.seed();
    const before = await w.read(id);
    await w.leave();
    const write = (cycle: string, at: string) =>
      withTenant(w.db, w.tenantId, async (tx) => {
        await lockEvaluation(tx, w.tenantId, id);
        await assertCycleActive(tx, w.ctx(at), cycle);
      });
    await write(before.cycle_id as string, '2026-10-20T15:59:59Z');
    await expect(write(before.cycle_id as string, '2026-10-20T16:00:00Z')).rejects.toMatchObject({
      status: 409,
      details: { reason: 'EMPLOYEE_LEFT' },
    });
    expect(await w.read(id)).toEqual(before);
    await w.business(w.f.mgrA.id, {
      kind: 'rehire',
      mode: 'direct',
      effectiveDate: '2026-10-22',
      fields: { departmentId: w.orgA },
    });
    const newCycle = await w.cycle();
    expect(newCycle).not.toBe(before.cycle_id);
    const newId = await w.seed({}, w.f.mgrA.id, newCycle);
    const newBefore = await w.read(newId);
    await write(newCycle, '2026-10-23T08:00:00Z');
    await expect(write(before.cycle_id as string, '2026-10-23T08:00:00Z')).rejects.toMatchObject({ status: 409 });
    await run(w, '2026-10-23T08:00:00Z');
    expect(await w.read(newId)).toEqual(newBefore);
    expect(await w.read(id)).toMatchObject({ terminated_reason: 'leave' });
  });
});
