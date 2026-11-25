/**
 * AC-OA-25-pg ⑤（R2-T08 §9.1 锁序、§6.4 离职不挂暂停）：调整单执行（调动行）vs 同员工离职生效。
 * 两者都先锁员工行（执行组按 UUID 升序取 employees，离职生效取同一把行锁）；让持锁会话占住该员工行，再按固定先后
 * 启动两个请求，等 pg_stat_activity 里恰有 N 个会话在等锁后放锁：恰一方成功，另一方是具体业务拒绝（执行组基线失败 /
 * 离职因员工 revision 已变 409），不是死锁。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferWorld } from './AC-OA-11cb-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { queueBehind, type HeldLockSpec } from './support/pg-interleave.js';

const testDb = useTestDb();

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-OA-25-pg ⑤ 执行（调动行）vs 同员工离职生效', () => {
  it.each(['执行先', '离职先'] as const)('员工行锁后两种先后（%s）：无死锁，恰一方成功', async (order) => {
    const w = await transferWorld(testDb().db, `oa25-5-${order}`);
    const mover = await w.staff(w.a);
    const adjustment = await w.approvedWithTransfers([w.a, w.b], [[mover]]);
    const revision = await w.inTenant(async (tx) =>
      Number(
        resultRows<{ revision: number }>(
          await tx.execute(sql`SELECT revision FROM employment_employees WHERE id = ${mover}`),
        )[0]!.revision,
      ),
    );
    const settings: HeldLockSpec = {
      run: (fn) => withTenant(testDb().db, w.tenant.id, fn),
      take: (tx: Tx) =>
        tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id = ${w.tenant.id} AND id = ${mover}::uuid
          FOR NO KEY UPDATE`),
    };
    const runner = () => w.run();
    const leave = () =>
      w.call('POST', `/api/tenant/employment/employees/${mover}/businesses`, {
        ifMatch: revision,
        body: { kind: 'leave', mode: 'direct', effectiveDate: '2026-11-01', lastWorkDate: '2026-10-31' },
      });

    const settled = await queueBehind(settings, testDb().db, order === '执行先' ? [runner, leave] : [leave, runner]);

    const [runResult, leaveResult] = order === '执行先' ? settled : [settled[1]!, settled[0]!];
    expect(runResult!.status, `执行无死锁：${JSON.stringify(runResult)}`).toBe('fulfilled');
    expect(leaveResult!.status, `离职无死锁：${JSON.stringify(leaveResult)}`).toBe('fulfilled');
    const response = (leaveResult as PromiseFulfilledResult<Response>).value;
    const text = await response.text();
    const [row] = await w.transferRows(adjustment.id);
    const executed = row!.execution_result === 1;
    const left = response.status === 201;
    expect(
      [executed, left],
      `恰一方成功：执行 ${row!.execution_result}/${row!.execution_reason}，离职 ${text}`,
    ).toSatisfy(([a, b]: boolean[]) => a !== b);
    expect(text).not.toContain('CONCURRENT_CONFLICT');
    // 失败方必须是具体业务拒绝，不能把别的失败（超时、500、其它原因）算作“恰一方成功”
    if (order === '执行先') {
      expect(executed).toBe(true);
      expect(response.status, `离职应因员工 revision 已变 409：${text}`).toBe(409);
    } else {
      expect(left).toBe(true);
      expect(row).toMatchObject({ execution_result: 2, execution_reason: 'BASELINE_CHANGED' });
    }
  });
});
