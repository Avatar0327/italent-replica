/**
 * AC-PT-date-request-pg（BE-7 PT-4c，docs/08_设计/R2-T05_兼职设计.md §4.4 / §7.1 / §7.5，§9 PB-41）：真 PostgreSQL 16、普通角色
 * （非超级用户、无 BYPASSRLS，租户表 FORCE RLS）下延长 / 结束申请的并发。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 * - E-4 互斥：A 的事务停在提交之前（已持员工行锁并写了申请），B 的 HTTP 请求在员工行锁上真实等待；A 提交后 B 复核 E-4 失败 ——
 *   恰一个申请头，失败方是明确的业务错误码 PART_TIME_REQUEST_IN_PROGRESS，不是死锁（40P01）转出来的并发冲突码。
 *   对手方三类：另一张延长 / 结束申请、直接改结束日期（PATCH part-times）、批量结束；
 * - 目标兼职记录头锁与申请头锁：上面几组竞争都先被员工行锁串行化，区分不出这两把锁是否存在；所以另让创建 / 提交停在组织校验阶段
 *   （已过员工锁、未写状态），用观察连接对记录头 / 申请头 NOWAIT 取锁，必须 55P03；去掉对应锁则 NOWAIT 取到锁、用例变红。
 */
import { sql, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';
import { waitForBlocked, withHeldLock } from './support/pg-interleave.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
/** 并发败者不得是死锁 / 序列化失败 / 锁超时转出来的并发冲突码。 */
const CONCURRENT_CODES = /CONCURRENT|DEADLOCK|SERIALIZ|LOCK_TIMEOUT/;
const EMPLOYMENT = '/api/tenant/employment';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 租户事务里执行 take 后停在提交之前，直到 withHeldLock 放行；take 失败会让 withHeldLock 直接抛出。 */
const holding = (w: RequestWorld, take: (tx: Tx) => Promise<unknown>) => ({ run: w.run, take });

const requestCount = (w: RequestWorld, recordId: string) =>
  w.run(async (tx) => {
    const [row] = rowsOf<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM part_time_requests
        WHERE tenant_id=${w.tenant.id} AND record_id=${recordId}::uuid`),
    );
    return row!.n;
  });

/** 观察连接对一行 NOWAIT 取锁：被他人持有返回 true（55P03）。 */
async function lockedBySomeone(w: RequestWorld, query: ReturnType<typeof sql>) {
  try {
    await w.run((tx) => tx.execute(query));
    return false;
  } catch (error) {
    const failure = error as { code?: string; cause?: { code?: string } };
    return (failure.code ?? failure.cause?.code) === '55P03';
  }
}

describe.skipIf(!realPostgres)('AC-PT-date-request-pg 延长 / 结束申请真 PG', () => {
  it('HTTP 全链路：延长 → 提交 → 四节点通过 → 同一条记录追加期限（真 PG、普通角色）', async () => {
    const w = await requestWorld(database().db, 'pt4c-pg-chain');
    const api = w.http();
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.ok(
      await api.createDate({ requestType: 'extend', recordId: record, endDate: '2026-12-31', submit: true }),
      201,
    );
    expect(created.status).toBe('in_review');
    await w.approveInOrder(created.id, w.order.extend);
    expect(await w.terms(record)).toEqual([
      { term_no: 1, end_date: '2026-10-31', source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-12-31', source: 'extend', source_id: created.id },
    ]);
  });

  it('E-4：A 先建延长申请（持员工行锁、未提交），B 的结束申请在锁上等待；放行后 B 得 PART_TIME_REQUEST_IN_PROGRESS，恰一个申请头', async () => {
    const w = await requestWorld(database().db, 'pt4c-pg-two-requests');
    const record = await w.seedRecord();
    const { b } = await withHeldLock(
      holding(w, (tx) =>
        import('../../apps/api/src/modules/employment/part-time/request-service.js').then(({ createDateRequest }) =>
          createDateRequest(tx, w.context(), { requestType: 'extend', recordId: record, endDate: '2026-12-31' }),
        ),
      ),
      async (lock) => {
        const pending = lock.track(
          w.http().createDate({ requestType: 'end', recordId: record, endDate: '2026-09-20' }),
        );
        await waitForBlocked(w.db, 1);
        return { b: pending };
      },
    );
    const loser = await w.refusal(await b);
    expect(loser).toMatchObject({ status: 409, code: 'CONFLICT', reason: 'PART_TIME_REQUEST_IN_PROGRESS' });
    expect(`${loser.code} ${loser.reason ?? ''}`).not.toMatch(CONCURRENT_CODES);
    expect(await requestCount(w, record)).toBe(1);
  });

  it('PB-41：A 先建结束申请（未提交），B 直接改结束日期（PATCH part-times）在锁上等待；放行后 409 PART_TIME_REQUEST_IN_PROGRESS，期限不变', async () => {
    const w = await requestWorld(database().db, 'pt4c-pg-direct-edit');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const { b } = await withHeldLock(
      holding(w, (tx) =>
        import('../../apps/api/src/modules/employment/part-time/request-service.js').then(({ createDateRequest }) =>
          createDateRequest(tx, w.context(), { requestType: 'end', recordId: record, endDate: '2026-09-20' }),
        ),
      ),
      async (lock) => {
        const pending = lock.track(
          w.request(w.hr.id, 'PATCH', `${EMPLOYMENT}/part-times/${record}`, {
            ifMatch: 1,
            body: { endDate: '2026-11-30' },
          }),
        );
        await waitForBlocked(w.db, 1);
        return { b: pending };
      },
    );
    const loser = await w.refusal(await b);
    expect(loser).toMatchObject({ status: 409, code: 'CONFLICT', reason: 'PART_TIME_REQUEST_IN_PROGRESS' });
    expect(`${loser.code} ${loser.reason ?? ''}`).not.toMatch(CONCURRENT_CODES);
    expect((await w.terms(record)).map((term) => term.end_date)).toEqual(['2026-10-31']);
  });

  it('PB-41：A 先建延长申请（未提交），B 批量结束同一兼职在锁上等待；放行后 409 PART_TIME_REQUEST_IN_PROGRESS，整批无写入', async () => {
    const w = await requestWorld(database().db, 'pt4c-pg-batch-end');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const { b } = await withHeldLock(
      holding(w, (tx) =>
        import('../../apps/api/src/modules/employment/part-time/request-service.js').then(({ createDateRequest }) =>
          createDateRequest(tx, w.context(), { requestType: 'extend', recordId: record, endDate: '2026-12-31' }),
        ),
      ),
      async (lock) => {
        const pending = lock.track(
          w.request(w.hr.id, 'POST', `${EMPLOYMENT}/part-times/batch-end`, {
            body: { items: [{ recordId: record, revision: 1 }], endDate: '2026-10-15' },
          }),
        );
        await waitForBlocked(w.db, 1);
        return { b: pending };
      },
    );
    const loser = await w.refusal(await b);
    expect(loser).toMatchObject({ status: 409, code: 'CONFLICT', reason: 'PART_TIME_REQUEST_IN_PROGRESS' });
    expect(`${loser.code} ${loser.reason ?? ''}`).not.toMatch(CONCURRENT_CODES);
    expect((await w.terms(record)).map((term) => term.end_date)).toEqual(['2026-10-31']);
  });

  it('目标兼职记录头锁：创建延长申请停在组织校验时（已过员工锁、未写申请），记录头已被锁（NOWAIT 55P03）；释放后创建 201', async () => {
    const w = await requestWorld(database().db, 'pt4c-pg-record-head-lock');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const held = signal();
    const release = signal();
    const holder = w.run(async (tx) => {
      await lockOrganizationSettings(tx, w.tenant.id);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const create = w.http().createDate({ requestType: 'extend', recordId: record, endDate: '2026-12-31' });
    let locked = false;
    try {
      await waitForBlocked(w.db, 1);
      locked = await lockedBySomeone(
        w,
        sql`SELECT id FROM employment_business_objects
          WHERE tenant_id=${w.tenant.id} AND id=${record}::uuid FOR UPDATE NOWAIT`,
      );
    } finally {
      release.resolve();
      await holder;
    }
    expect((await create).status).toBe(201);
    expect(locked, '创建已过员工锁、正等组织锁时，目标兼职记录的业务头应已被锁住').toBe(true);
  });

  it('提交延长申请停在组织校验时：申请头与目标兼职记录头都已被锁（NOWAIT 55P03）；释放后提交 200', async () => {
    const w = await requestWorld(database().db, 'pt4c-pg-submit-locks');
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const api = w.http();
    const created = await w.ok(
      await api.createDate({ requestType: 'extend', recordId: record, endDate: '2026-12-31' }),
      201,
    );
    const held = signal();
    const release = signal();
    const holder = w.run(async (tx) => {
      await lockOrganizationSettings(tx, w.tenant.id);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const submit = api.act(created.id, 'submit', created.revision);
    let requestLocked = false;
    let recordLocked = false;
    try {
      await waitForBlocked(w.db, 1);
      requestLocked = await lockedBySomeone(
        w,
        sql`SELECT id FROM part_time_requests
          WHERE tenant_id=${w.tenant.id} AND id=${created.id}::uuid FOR UPDATE NOWAIT`,
      );
      recordLocked = await lockedBySomeone(
        w,
        sql`SELECT id FROM employment_business_objects
          WHERE tenant_id=${w.tenant.id} AND id=${record}::uuid FOR UPDATE NOWAIT`,
      );
    } finally {
      release.resolve();
      await holder;
    }
    expect((await submit).status).toBe(200);
    expect(requestLocked, '提交已过员工锁、正等组织锁时，申请头应已被锁住').toBe(true);
    expect(recordLocked, '提交已过员工锁、正等组织锁时，目标兼职记录头应已被锁住').toBe(true);
  });
});
