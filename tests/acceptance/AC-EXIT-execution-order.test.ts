/**
 * AC-DM-26（SQL 侧，docs/08_设计/R2-T03_离职管理设计.md §5.0 / §5.0A、D-3 / D-4）：
 * 待生效队列的最终执行日期、同日先后与到期截取只有一个来源（纯函数 execution-order.ts ≡ SQL `finalExecutionDateSql`）。
 * 对调动与 main 现有 kind 结果不变的回归见 AC-EXIT-b81-regression.test.ts。
 */
import { sql, withTenant } from '@italent/db';
import { CYCLE_OPENING_KINDS, compareExecutionOrder, EXECUTION_KINDS, finalExecutionDate } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { dueQueue } from '../../apps/api/src/modules/employment/activation-service.js';
import { finalExecutionDateSql, pendingActivations } from '../../apps/api/src/modules/employment/activation-store.js';
import { resultRows } from './AC-ORG-people-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import {
  derived,
  manual,
  plannedOf,
  queueContext,
  randomApplication,
  seedQueue,
  seeded,
  TODAY,
} from './AC-EXIT-queue-support.js';

const database = useTestDb();

describe('AC-DM-26：SQL 队列 ≡ 纯函数（含离职与多次迟到顺延）', () => {
  it('finalExecutionDateSql 与 finalExecutionDate 对全部 kind × 计划日 × 执行日逐点相等', async () => {
    const w = await activationWorld(database().db, 'exit-final-grid');
    const planned = ['2026-09-30', '2026-10-17', '2026-10-18', '2026-10-19', '2027-01-01'];
    const executions = ['2026-10-01', '2026-10-18', '2026-12-31'];
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      for (const kind of EXECUTION_KINDS)
        for (const plannedDate of planned)
          for (const executionDate of executions) {
            const expression = finalExecutionDateSql(sql`${kind}::text`, sql`${plannedDate}::date`, executionDate);
            const [row] = resultRows<{ value: string }>(await tx.execute(sql`SELECT ${expression}::text AS value`));
            expect(row!.value, `${kind} ${plannedDate} @ ${executionDate}`).toBe(
              finalExecutionDate({ kind, plannedEffectiveDate: plannedDate, lastWorkDate: null, executionDate }),
            );
          }
    });
  });

  it('随机队列（全部 kind、多次改期与迟到顺延、全部版本同一 created_at）：SQL 顺序与字段 ≡ compareExecutionOrder 排序', async () => {
    const w = await activationWorld(database().db, 'exit-queue-equivalence');
    const random = seeded(2026);
    for (let round = 0; round < 6; round++) {
      const applications = Array.from({ length: 10 }, (_unused, index) =>
        randomApplication(random, EXECUTION_KINDS, 1000 + round * 100 + index * 7),
      );
      const person = (await w.hired(`队列员工 ${round}`)).employee;
      const ids = await seedQueue(w, person.id, applications);
      const queue = await withTenant(w.db, w.session.tenant.id, (tx) =>
        pendingActivations(tx, queueContext(w), person.id),
      );
      const expected = applications
        .map((application, index) => {
          const plannedDate = plannedOf(application.versions);
          const finalDate = finalExecutionDate({
            kind: application.kind,
            plannedEffectiveDate: plannedDate,
            lastWorkDate: null,
            executionDate: TODAY,
          });
          return {
            id: ids[index]!,
            plannedDate,
            finalDate,
            key: {
              finalDate,
              plannedDate,
              opensCycle: CYCLE_OPENING_KINDS.includes(application.kind),
              operationKey: application.submitSeq,
            },
          };
        })
        .sort((a, b) => compareExecutionOrder(a.key, b.key));
      expect(
        queue.map((item) => item.id),
        `round ${round}`,
      ).toEqual(expected.map((item) => item.id));
      expect(queue.map((item) => [item.plannedDate, item.finalDate])).toEqual(
        expected.map((item) => [item.plannedDate, item.finalDate]),
      );
    }
  });

  it('第 5 轮 P2-01 原反例：迟到调动 T（计划 10-10）与离职（E = 10-16）同在 10-18 执行，队列为 [T, 离职]', async () => {
    const w = await activationWorld(database().db, 'exit-p201');
    const person = await w.hired();
    const [exit, transfer] = await seedQueue(w, person.employee.id, [
      { kind: 'leave', versions: [manual(1, '2026-10-16')], submitSeq: 3000 },
      { kind: 'transfer', versions: [manual(1, '2026-10-10')], submitSeq: 3001 },
    ]);
    const queue = await withTenant(w.db, w.session.tenant.id, (tx) =>
      pendingActivations(tx, queueContext(w), person.employee.id),
    );
    expect(queue.map((item) => item.id)).toEqual([transfer, exit]);
    expect(queue.map((item) => item.finalDate)).toEqual(['2026-10-18', '2026-10-18']);
    expect(queue.map((item) => item.plannedDate)).toEqual(['2026-10-10', '2026-10-16']);
  });
});

describe('AC-DM-26 D-4：到期截取读计划日', () => {
  it('计划日 ≤ 今天即到期；计划日在未来不到期', async () => {
    const w = await activationWorld(database().db, 'exit-due-queue');
    const person = await w.hired();
    const [due, future, postponed] = await seedQueue(w, person.employee.id, [
      { kind: 'transfer', versions: [manual(1, '2026-10-18')], submitSeq: 4000 },
      { kind: 'transfer', versions: [manual(1, '2026-10-19')], submitSeq: 4001 },
      // 计划 10-10；系统顺延版本把载荷日写成 10-12（已过的执行日）
      { kind: 'transfer', versions: [manual(1, '2026-10-10'), derived(2, '2026-10-12')], submitSeq: 4002 },
    ]);
    const queue = await withTenant(w.db, w.session.tenant.id, (tx) =>
      dueQueue(tx, queueContext(w), person.employee.id),
    );
    expect(new Set(queue.map((item) => item.id))).toEqual(new Set([due, postponed]));
    expect(queue.map((item) => item.id)).not.toContain(future);
  });

  it('计划日已到、载荷日写在未来的版本序列：仍按计划日到期（统一来源，不读载荷日）', async () => {
    const w = await activationWorld(database().db, 'exit-due-planned');
    const person = await w.hired();
    const [id] = await seedQueue(w, person.employee.id, [
      { kind: 'transfer', versions: [manual(1, '2026-10-10'), derived(2, '2026-10-30')], submitSeq: 4100 },
    ]);
    const queue = await withTenant(w.db, w.session.tenant.id, (tx) =>
      dueQueue(tx, queueContext(w), person.employee.id),
    );
    expect(queue.map((item) => item.id)).toEqual([id]);
  });

  it('对可达状态与 main 原写法（载荷日 ≤ 今天）等价：随机队列逐条相同', async () => {
    const w = await activationWorld(database().db, 'exit-due-equivalence');
    const random = seeded(404);
    for (const today of ['2026-10-12', '2026-10-18', '2026-11-05']) {
      const applications = Array.from({ length: 10 }, (_unused, index) =>
        randomApplication(random, EXECUTION_KINDS, 6000 + index * 7, today),
      );
      const person = (await w.hired(`到期 ${today}`)).employee;
      await seedQueue(w, person.id, applications);
      const all = await withTenant(w.db, w.session.tenant.id, (tx) =>
        pendingActivations(tx, queueContext(w, today), person.id),
      );
      const due = await withTenant(w.db, w.session.tenant.id, (tx) => dueQueue(tx, queueContext(w, today), person.id));
      expect(due.map((item) => item.id)).toEqual(
        all.filter((item) => item.effectiveDate <= today).map((item) => item.id),
      );
    }
  });
});
