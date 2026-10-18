/**
 * AC-PT-request-pg（BE-7 PT-4b，docs/08_设计/R2-T05_兼职设计.md §4.4 / §7.1 / §7.5，§9 PB-32）：真 PostgreSQL 16、普通角色
 * （非超级用户、无 BYPASSRLS，租户表 FORCE RLS）下的新增申请 HTTP 全链路与并发。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 * - 全链路：新增申请 → 提交 → 四节点通过 → 落地进“未开始”，全部经公开入口与审批中心接口；
 * - 并发提交 / 撤回同一申请：A 的事务停在提交之前（已持员工行锁），B 的 HTTP 请求在员工行锁上真实等待；A 提交后 B 带着旧
 *   revision 复核失败 —— 恰一方成功，失败方是明确的业务错误码 REVISION_CONFLICT，不是死锁（40P01）转出来的并发冲突码；
 * - 同 revision 的两个提交（不同命令 ID）：同理恰一个成功；撤回 vs 撤销（HR）：先到者生效，后到者 REVISION_CONFLICT。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { submitRequest, withdrawRequest } from '../../apps/api/src/modules/employment/part-time/request-service.js';
import { ALL_VISIBLE, requestWorld, type RequestWorld } from './AC-PT-request-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
/** 并发败者不得是死锁 / 序列化失败 / 锁超时转出来的并发冲突码。 */
const CONCURRENT_CODES = /CONCURRENT|DEADLOCK|SERIALIZ|LOCK_TIMEOUT/;

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 在租户事务里执行 work，停在提交之前直到 release；返回提交结果（成功 undefined，失败为错误）。 */
function holdThen(w: RequestWorld, work: Parameters<RequestWorld['run']>[0]) {
  const held = signal();
  const release = signal();
  const done = w
    .run(async (tx) => {
      await work(tx);
      held.resolve();
      await release.promise;
    })
    .then(
      () => undefined,
      (error: unknown) => {
        held.resolve();
        return error;
      },
    );
  return { held: held.promise, release: release.resolve, done };
}

describe.skipIf(!realPostgres)('AC-PT-request-pg 新增兼职申请真 PG', () => {
  it('连接角色是普通角色（非超级用户、无 BYPASSRLS）', async () => {
    const w = await requestWorld(database().db, 'pt4b-pg-role');
    const [role] = await w.run(async (tx) =>
      rowsOf<{ rolsuper: boolean; rolbypassrls: boolean }>(
        await tx.execute(sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`),
      ),
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('PB-32：HTTP 全链路 —— 新增申请 → 提交 → 四节点通过 → 落地进“未开始”', async () => {
    const w = await requestWorld(database().db, 'pt4b-pg-chain');
    const api = w.http();
    const created = await w.ok(await api.create({ startDate: '2026-11-01', endDate: '2026-12-31' }), 201);
    expect(created.status).toBe('draft');
    const submitted = await w.ok(await api.act(created.id, 'submit', created.revision));
    expect(submitted.status).toBe('in_review');
    expect(await w.partTimeRecords()).toEqual([]);
    await w.approveAll(created.id);
    const landed = await w.ok(await api.one(created.id));
    const [record] = await w.partTimeRecords();
    expect(landed).toMatchObject({ status: 'effective', recordId: record!.id });
    const listed = await w.ok<{ items: { id: string; partTimeView: string[] }[] }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${w.worker.employeeId}/part-times`),
    );
    expect(listed.items).toEqual([
      expect.objectContaining({ id: record!.id, partTimeView: expect.arrayContaining(['not_started']) }),
    ]);
    expect(await w.terms(record!.id)).toEqual([
      { term_no: 1, end_date: '2026-12-31', source: 'create', source_id: created.id },
    ]);
  });

  it('并发提交 vs 撤回：A 先持员工行锁提交，B 的撤回在锁上等待；放行后 B 复核失败为 REVISION_CONFLICT，恰一方成功', async () => {
    const w = await requestWorld(database().db, 'pt4b-pg-submit-withdraw');
    const api = w.http();
    const created = await w.ok(await api.create({ endDate: '2026-12-31' }), 201);
    const a = holdThen(w, (tx) => submitRequest(tx, w.context(created.revision), created.id, ALL_VISIBLE));
    await a.held;
    const b = api.act(created.id, 'withdraw', created.revision);
    await waitForBlocked(w.db, 1);
    a.release();
    expect(await a.done).toBeUndefined();
    const loser = await w.refusal(await b);
    expect(loser).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect(`${loser.code} ${loser.reason ?? ''}`).not.toMatch(CONCURRENT_CODES);
    expect((await w.load(created.id)).state).toBe('in_review');
    expect((await w.states(created.id)).map((row) => row.state)).toEqual(['draft', 'in_review']);
  });

  it('并发撤回 vs 提交：撤回先持锁，提交（同一旧 revision）后到复核失败；恰一方成功，申请回到草稿', async () => {
    const w = await requestWorld(database().db, 'pt4b-pg-withdraw-submit');
    const api = w.http();
    const created = await w.ok(await api.create({ endDate: '2026-12-31' }), 201);
    const submitted = await w.ok(await api.act(created.id, 'submit', created.revision));
    const a = holdThen(w, (tx) => withdrawRequest(tx, w.context(submitted.revision), created.id));
    await a.held;
    const b = api.act(created.id, 'submit', submitted.revision);
    await waitForBlocked(w.db, 1);
    a.release();
    expect(await a.done).toBeUndefined();
    const loser = await w.refusal(await b);
    expect(loser).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect(`${loser.code} ${loser.reason ?? ''}`).not.toMatch(CONCURRENT_CODES);
    expect((await w.load(created.id)).state).toBe('draft');
    expect((await w.states(created.id)).map((row) => row.state)).toEqual(['draft', 'in_review', 'draft']);
    // 审批侧：实例已随撤回结束，没有遗留待办
    expect(w.pending(await w.instance(created.id))).toEqual([]);
  });

  it('同 revision 的两个提交（不同命令 ID）：恰一个成功，另一个 REVISION_CONFLICT，只有一个审批实例', async () => {
    const w = await requestWorld(database().db, 'pt4b-pg-double-submit');
    const api = w.http();
    const created = await w.ok(await api.create({ endDate: '2026-12-31' }), 201);
    const a = holdThen(w, (tx) => submitRequest(tx, w.context(created.revision), created.id, ALL_VISIBLE));
    await a.held;
    const b = api.act(created.id, 'submit', created.revision);
    await waitForBlocked(w.db, 1);
    a.release();
    expect(await a.done).toBeUndefined();
    expect(await w.refusal(await b)).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    const instances = await w.run(async (tx) =>
      rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM approval_instances
          WHERE tenant_id=${w.tenant.id} AND business_id=${created.id}::uuid`),
      ),
    );
    expect(instances).toEqual([{ n: 1 }]);
  });

  it('撤销（HR）vs 撤回（发起人）同一审批中申请：先到者生效，后到者 REVISION_CONFLICT，实例只取消一次', async () => {
    const w = await requestWorld(database().db, 'pt4b-pg-revoke-withdraw');
    const api = w.http();
    const created = await w.ok(await api.create({ endDate: '2026-12-31' }), 201);
    const submitted = await w.ok(await api.act(created.id, 'submit', created.revision));
    const a = holdThen(w, (tx) => withdrawRequest(tx, w.context(submitted.revision), created.id));
    await a.held;
    const b = api.act(created.id, 'revoke', submitted.revision);
    await waitForBlocked(w.db, 1);
    a.release();
    expect(await a.done).toBeUndefined();
    expect(await w.refusal(await b)).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect((await w.load(created.id)).state).toBe('draft');
  });
});
