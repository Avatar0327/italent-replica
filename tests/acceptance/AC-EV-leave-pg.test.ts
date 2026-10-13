/** C2-1b 真 PG：员工锁交错、旧离职迟消费、迁移锁表防止入队窗口丢失。 */
import { sql, withTenant } from '@italent/db';
import { createTestDb, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { lockEmploymentEmployee } from '../../apps/api/src/modules/employment/record-store.js';
import { assertCycleActive } from '../../apps/api/src/modules/evaluation/cycle-guard.js';
import { evaluationLeaveProbe, runEvaluationLeave } from '../../apps/api/src/modules/evaluation/leave-handler.js';
import {
  evaluationLeaveWorld,
  lockEvaluation,
  signal,
  waitForLock,
  LEAVE_MIGRATION,
  replayLeaveMigration,
} from './AC-EV-leave-support.js';

const database = useTestDb();
describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-EV-leave-pg：设计 §7.4 ③⑥⑩', () => {
  it('离职处理器先持员工锁，评定写入真实等待，放行后 409，已终止评定不被写入', async () => {
    const w = await evaluationLeaveWorld(database().db);
    const id = await w.seed();
    await w.leave();
    const held = signal();
    const release = signal();
    evaluationLeaveProbe.afterRecheck = async () => {
      held.resolve();
      await release.promise;
    };
    let worker: Promise<unknown> | undefined;
    let writer: Promise<unknown> | undefined;
    try {
      worker = runEvaluationLeave(w.db, w.tenantId, { clock: () => w.ctx().now });
      await held.promise;
      let finished = false;
      writer = withTenant(w.db, w.tenantId, async (tx) => {
        await lockEmploymentEmployee(tx, w.ctx(), w.f.mgrA.id);
        await lockEvaluation(tx, w.tenantId, id);
        await assertCycleActive(tx, w.ctx(), await w.cycle());
        await tx.execute(sql`UPDATE ev_staff_evaluations SET final_score=99
          WHERE tenant_id=${w.tenantId} AND id=${id}::uuid`);
      })
        .then(
          () => ({ status: 200 }),
          (error: unknown) => error,
        )
        .finally(() => {
          finished = true;
        });
      await waitForLock(w.db, () => finished);
      release.resolve();
      await worker;
      expect(await writer).toMatchObject({ status: 409, details: { reason: 'EMPLOYEE_LEFT' } });
      expect(await w.read(id)).toMatchObject({ terminated_reason: 'leave', final_score: null });
    } finally {
      release.resolve();
      await Promise.allSettled([worker, writer]);
      evaluationLeaveProbe.afterRecheck = undefined;
    }
  });

  it('评定写入先持员工锁，离职登记等待；写入提交后离职落地并终止，没有丢失更新', async () => {
    const w = await evaluationLeaveWorld(database().db);
    const id = await w.seed();
    const cycleId = await w.cycle();
    const held = signal();
    const release = signal();
    const writer = withTenant(w.db, w.tenantId, async (tx) => {
      await lockEmploymentEmployee(tx, w.ctx(), w.f.mgrA.id);
      await lockEvaluation(tx, w.tenantId, id);
      await assertCycleActive(tx, w.ctx(), cycleId);
      held.resolve();
      await release.promise;
      await tx.execute(sql`UPDATE ev_staff_evaluations SET final_score=88, revision=revision+1
        WHERE tenant_id=${w.tenantId} AND id=${id}::uuid`);
    });
    let leaving: ReturnType<typeof w.leave> | undefined;
    try {
      await held.promise;
      let finished = false;
      leaving = w.leave().finally(() => {
        finished = true;
      });
      await waitForLock(w.db, () => finished);
      release.resolve();
      await writer;
      await leaving;
      expect(await runEvaluationLeave(w.db, w.tenantId, { clock: () => w.ctx().now })).toMatchObject({ done: 1 });
      expect(await w.read(id)).toMatchObject({ terminated_reason: 'leave', final_score: '88.00', revision: 3 });
    } finally {
      release.resolve();
      await Promise.allSettled([writer, leaving]);
    }
  });

  it.each(['writer_first', 'migration_first'] as const)(
    '迁移与未提交离职事件交错 %s：未来离职补入与新事件都不丢、各只有一行',
    async (order) => {
      const handle = await createTestDb({ migrateBefore: LEAVE_MIGRATION });
      const held = signal();
      const release = signal();
      let first: Promise<unknown> | undefined;
      let second: Promise<unknown> | undefined;
      try {
        const w = await evaluationLeaveWorld(handle.db);
        const leave = await w.leave('2026-12-20');
        const other = order === 'writer_first' ? await w.leave('2026-12-20', w.f.mgrB.id) : null;
        let otherId = other?.id;
        const insert = async (pause: boolean) =>
          withTenant(w.db, w.tenantId, async (tx) => {
            await tx.execute(sql`INSERT INTO employment_outbox
          (tenant_id, employee_id, business_id, object_type, object_id, event_type, payload,
            state, command_id, payload_version_id, created_at)
          SELECT tenant_id, employee_id, business_id, object_type, object_id, event_type, payload,
            state, 'interleave-' || gen_random_uuid()::text, payload_version_id, created_at
          FROM employment_outbox WHERE tenant_id=${w.tenantId} AND object_id=${other!.id}::uuid
            AND event_type='employment.record.create' LIMIT 1`);
            if (pause) {
              held.resolve();
              await release.promise;
            }
          });
        if (order === 'writer_first') first = insert(true);
        else
          first = handle.db.transaction(async (tx) => {
            await tx.execute(sql`LOCK TABLE employment_outbox IN SHARE ROW EXCLUSIVE MODE`);
            await replayLeaveMigration(tx);
            held.resolve();
            await release.promise;
          });
        await held.promise;
        let finished = false;
        second = (
          order === 'writer_first'
            ? handle.migrate()
            : w.leave('2026-12-20', w.f.mgrB.id).then((saved) => {
                otherId = saved.id;
              })
        ).finally(() => {
          finished = true;
        });
        await waitForLock(w.db, () => finished);
        release.resolve();
        await Promise.all([first, second]);
        expect(otherId).toBeTruthy();
        expect(await w.queue(leave.id)).toHaveLength(1);
        expect(await w.queue(otherId!)).toHaveLength(1);
        await replayLeaveMigration(handle.db);
        expect(await w.queue(leave.id)).toHaveLength(1);
        expect(await w.queue(otherId!)).toHaveLength(1);
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
        await handle.close();
      }
    },
  );
});
