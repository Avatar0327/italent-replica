/**
 * DEC-272：迟到判定共用函数（packages/domain/employment/late-execution.ts）在调动调度上的三组边界——
 * 生效日当天执行不顺延、晚 1 天顺延到执行日、跨月顺延到执行日；SQL 投影 greatest(生效日, 执行日) 与函数等价。
 */
import { sql } from '@italent/db';
import { resolveLateExecution } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { resultRows } from './AC-ORG-people-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();

it.each([
  ['生效日当天执行，不顺延', '2026-10-05', '2026-10-05T01:00:00Z', false],
  ['晚 1 天执行，顺延到执行日', '2026-10-05', '2026-10-06T01:00:00Z', true],
  ['跨月执行，顺延到执行日', '2026-10-31', '2026-11-02T01:00:00Z', true],
] as const)('AC-TRF-F017 DEC-272 调动：%s', async (_name, planned, runAt, late) => {
  const w = await activationWorld(database().db, `dec272${planned}`);
  const person = await w.hired();
  const transfer = await w.session.business(
    person.employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: planned, fields: { departmentId: w.to.id } },
    person.hire.employeeRevision,
  );
  expect(await w.runScheduler(runAt)).toMatchObject({ failed: [], errors: [] });
  expect((await w.business(transfer.id)).activation).toMatchObject({ status: 'effective' });
  const expected = resolveLateExecution({ plannedEffectiveDate: planned, executionDate: runAt.slice(0, 10) });
  expect(expected.late).toBe(late);
  expect(await w.session.record(transfer.id, expected.effectiveDate)).toMatchObject({
    effectiveDate: expected.effectiveDate,
    isCurrent: true,
    fields: { departmentId: w.to.id },
  });
  const rescheduled = (await w.auditEvents(transfer.id)).filter(
    (event) => event.action === 'employment.transfer.rescheduled',
  );
  expect(rescheduled).toHaveLength(late ? 1 : 0);
  if (late)
    expect(rescheduled[0]!.after).toMatchObject({
      originalEffectiveDate: planned,
      effectiveDate: expected.effectiveDate,
    });
});

it('AC-TRF-F017 DEC-272 SQL 投影 greatest(生效日, 执行日) 与共用函数等价', async () => {
  const { db } = database();
  const pairs = [
    ['2026-10-05', '2026-10-05'],
    ['2026-10-05', '2026-10-06'],
    ['2026-10-31', '2026-11-02'],
    ['2026-10-05', '2026-10-04'],
    ['2026-12-31', '2027-01-01'],
  ] as const;
  for (const [planned, execution] of pairs) {
    const [row] = resultRows<{ projected: string }>(
      await db.execute(sql`SELECT greatest(${planned}::date, ${execution}::date)::text AS projected`),
    );
    expect(row!.projected, `${planned} / ${execution}`).toBe(
      resolveLateExecution({ plannedEffectiveDate: planned, executionDate: execution }).effectiveDate,
    );
  }
});
