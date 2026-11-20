/**
 * AC-ESIGN-F505-18（S1 部分，设计 §5、§12）：来源事件端口与锁序契约——
 * 端口同事务调用、订阅方按名称排序、订阅方抛错使整笔写入回滚、同名异实现登记报错；
 * 锁序“Offer → 员工 → 任职业务 → 组织 → 签署任务”的判定函数，以及真 PG 上反向取锁会死锁的探针。
 * 撤销通知写失败时源操作 / 任务 / 审计 / 锚点整体回滚的业务断言留 S3（需发起与撤销服务）。
 */
import { randomUUID } from 'node:crypto';
import { pgErrorCode, sql, withTenant } from '@italent/db';
import { type ESignSourceEvent, isLockOrderViolation, SOURCE_LOCK_ORDER } from '@italent/domain';
import { testDbMode, useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  entrySourceEvents,
  registerEntrySourceEvents,
  resetEntrySourceEventsForTest,
} from '../../apps/api/src/modules/employment/entry-source-events.js';
import {
  offerSourceEvents,
  registerOfferSourceEvents,
  resetOfferSourceEventsForTest,
} from '../../apps/api/src/modules/offer/source-events.js';
import { rowsOf, sourceWorld } from './AC-ESIGN-F505-support.js';
import { settledOrBlocked } from './support/pg-interleave.js';

const db = useTestDb();
afterEach(() => {
  resetOfferSourceEventsForTest();
  resetEntrySourceEventsForTest();
});

const ctx = (tenantId: string) => ({
  tenantId,
  userId: randomUUID(),
  timezone: 'Asia/Shanghai',
  now: new Date('2026-10-17T01:00:00.000Z'),
  commandId: randomUUID(),
});
const event = (source: 'offer' | 'entry', change: ESignSourceEvent['change'] = 'deleted'): ESignSourceEvent => ({
  source,
  sourceId: randomUUID(),
  change,
  revision: 2,
});
const ports = {
  offer: { register: registerOfferSourceEvents, emit: offerSourceEvents.emit },
  entry: { register: registerEntrySourceEvents, emit: entrySourceEvents.emit },
} as const;

describe.each(['offer', 'entry'] as const)('AC-ESIGN-F505-18 %s 来源事件端口', (source) => {
  const port = ports[source];

  it('没有订阅方时不报错；订阅方按名称顺序调用，与登记先后无关', async () => {
    const w = await sourceWorld(db().db, `port-order-${source}`);
    await withTenant(db().db, w.tenantId, (tx) => port.emit(tx, ctx(w.tenantId), event(source)));
    const calls: string[] = [];
    for (const name of ['zeta', 'alpha', 'mid']) port.register(name, async () => void calls.push(name));
    await withTenant(db().db, w.tenantId, (tx) => port.emit(tx, ctx(w.tenantId), event(source)));
    expect(calls).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('订阅方拿到的是调用方同一个事务：能看到未提交的写入；抛错使整笔写入回滚', async () => {
    const w = await sourceWorld(db().db, `port-tx-${source}`);
    const offerId = await w.offer('pending');
    let seen = 0;
    port.register('probe', async (tx) => {
      seen = rowsOf(await tx.execute(sql`SELECT 1 FROM offers WHERE id = ${offerId}::uuid AND name = '已改'`)).length;
      throw new Error('合成订阅方失败');
    });
    await expect(
      withTenant(db().db, w.tenantId, async (tx) => {
        await tx.execute(sql`UPDATE offers SET name = '已改' WHERE id = ${offerId}::uuid`);
        await port.emit(tx, ctx(w.tenantId), event(source));
      }),
    ).rejects.toThrow('合成订阅方失败');
    expect(seen).toBe(1);
    const [row] = rowsOf<{ name: string }>(
      await withTenant(db().db, w.tenantId, (tx) =>
        tx.execute(sql`SELECT name FROM offers WHERE id = ${offerId}::uuid`),
      ),
    );
    expect(row!.name).toBe('ZZ_F505_候选人');
  });

  it('同名同实现登记幂等，同名换实现是装配错误', () => {
    const handler = async () => undefined;
    port.register('esign', handler);
    port.register('esign', handler);
    expect(() => port.register('esign', async () => undefined)).toThrow(/esign/);
  });
});

describe('AC-ESIGN-F505-18 锁序契约', () => {
  it('固定顺序 Offer → 员工 → 任职业务 → 组织 → 签署任务；只能向后取锁', () => {
    expect(SOURCE_LOCK_ORDER).toEqual(['offer', 'employee', 'business', 'org', 'task']);
    expect(isLockOrderViolation(['offer', 'employee'], 'business')).toBe(false);
    expect(isLockOrderViolation(['offer'], 'task')).toBe(false);
    expect(isLockOrderViolation(['task'], 'offer')).toBe(true);
    expect(isLockOrderViolation(['business', 'task'], 'employee')).toBe(true);
    expect(isLockOrderViolation(['org'], 'business')).toBe(true);
  });

  it('真 PG 探针：先持任务锁再取 Offer 锁，与“先 Offer 后任务”的正向事务互等，被数据库判死锁', async (context) => {
    if (testDbMode() !== 'pg') context.skip('PGlite 单连接无法并发，锁序探针只在真 PostgreSQL 上跑');
    const w = await sourceWorld(db().db, 'probe');
    const offerId = await w.offer();
    await w.anchor(offerId);
    const taskId = await w.task({ scene: 'offer', offerId, employeeId: w.person.employee.id, sourceRevision: 1 });
    const lockOffer = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
      tx.execute(sql`SELECT 1 FROM offers WHERE id = ${offerId}::uuid FOR UPDATE`);
    const lockTask = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
      tx.execute(sql`SELECT 1 FROM esign_tasks WHERE id = ${taskId}::uuid FOR UPDATE`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // 正向事务：Offer → 任务；反向事务：任务 → Offer。反向事务先取到任务锁，正向事务取 Offer 锁后再要任务锁。
    const forward = withTenant(db().db, w.tenantId, async (tx) => {
      await lockOffer(tx);
      await gate;
      await lockTask(tx);
    });
    const reverse = withTenant(db().db, w.tenantId, async (tx) => {
      await lockTask(tx);
      release();
      await settledOrBlocked(db().db, forward, 1);
      await lockOffer(tx);
    });
    const outcomes = await Promise.allSettled([forward, reverse]);
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(failed).toHaveLength(1);
    // Drizzle 把驱动错误包在 Failed query 里，按 SQLSTATE 判（40P01 = deadlock_detected），不依赖文案
    expect(pgErrorCode((failed[0] as PromiseRejectedResult).reason)).toBe('40P01');
  });
});
