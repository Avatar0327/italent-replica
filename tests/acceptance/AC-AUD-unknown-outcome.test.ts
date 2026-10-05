/**
 * PR #75 第二轮 P2-8：命令执行器把“结果未知”（提交阶段连接中断、台账查无）交给调用方时，调用方必须仍能识别为
 * 结果未知，不能因为它也是 503 应用错误就判成确定失败。人员序码调度的回执与失败命令审计都记 unknown。
 * 本文件只建一个租户：调度先在平台路径列租户（第 1 个事务），第 2 个事务即该租户的重算命令。
 */
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { runOrderCodeJobs } from '../../apps/api/src/modules/personnel/order-code-scheduler.js';
import { rows } from '../../apps/api/src/modules/personnel/store.js';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const NOW = '2026-10-01T01:00:00.000Z';
const clock = () => new Date(NOW);
const ROLLBACK = new Error('test rollback');

/** 第 n 个事务执行完回调后回滚，再报告连接中断：模拟“提交请求已发出、结果没有回来”。 */
function lostCommitAt(db: Db, n: number): Db {
  let count = 0;
  const wrapper = Object.create(db) as Db;
  wrapper.transaction = (async (fn: Parameters<Db['transaction']>[0]) => {
    count += 1;
    if (count !== n) return db.transaction(fn);
    await db
      .transaction(async (tx) => {
        await fn(tx);
        throw ROLLBACK;
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });
    throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
  }) as Db['transaction'];
  return wrapper;
}

it('序码定时重算提交结果未知：调度回执记 unknown，失败命令审计也记 unknown', async () => {
  const db = database().db;
  const w = await employmentSession(db, 'aud-unknown-order');
  const person = await w.employee('序码人员', 'A');
  await w.business(person.id, { kind: 'hire', mode: 'direct', effectiveDate: '2020-01-01', fields: {} }, 1);
  const settings = await tenantApi(db, { clock }).request('PUT', '/api/tenant/personnel/order-code/settings', {
    user: w.user.id,
    tenant: w.tenant.id,
    ifMatch: 0,
    body: { enabled: true, items: [{ field: 'code', direction: 'asc', enabled: true }] },
  });
  expect(settings.status).toBe(200);

  const result = await runOrderCodeJobs(lostCommitAt(db, 2), { clock, onError: () => undefined });
  expect(result.failures).toEqual([expect.objectContaining({ tenantId: w.tenant.id, state: 'unknown' })]);
  await withTenant(db, w.tenant.id, async (tx) => {
    expect(rows(await tx.execute(sql`SELECT state FROM personnel_order_runs`))).toEqual([{ state: 'unknown' }]);
    expect(rows(await tx.execute(sql`SELECT outcome FROM audit_command_failures`))).toEqual([{ outcome: 'unknown' }]);
  });
});
