/** AC-SC-02 / #266 P2-1：整页 B→A 员工顺序不能反转 A2 的 A→B 目标锁序。 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitWorld, runner, type ExitWorld } from './AC-SC-02-support.js';
import { tenantApi } from './support/tenant-api.js';
import { rowsOf } from './support/f048.js';
import { settledOrBlocked, waitForBlocked } from './support/pg-interleave.js';
import {
  SUCCESSION_CALC_KINDS,
  CalcBlocked,
  defineCalcKinds,
  type CalcHandler,
} from '../../apps/api/src/modules/succession/calc-contract.js';
import { EXIT_SWEEP_PRODUCER } from '../../apps/api/src/modules/succession/exit-sweep.js';
import { changeCalcRun, runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';

const testDb = useTestDb();
const now = new Date('2026-10-02T01:00:00Z');
const pg = describe.runIf(Boolean(process.env.TEST_DATABASE_URL));
type Target = { kind: 'org' | 'position'; id: string };
const actual = () => SUCCESSION_CALC_KINDS.find((h) => h.kind === 'exit_sweep')!;

async function world(mixed: boolean, retry = false) {
  const w = await exitWorld(testDb().db, `sc-page-locks-${mixed}-${retry}`);
  await runner(w);
  const employees = [await w.hire(), await w.hire()].sort((a, b) => a.id.localeCompare(b.id));
  const targets: Target[] = mixed
    ? [
        { kind: 'org', id: w.targetOrg.id },
        { kind: 'position', id: w.targetPosition.id },
      ]
    : [w.targetOrg, await w.org('另一离职目标')]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((o) => ({ kind: 'org', id: o.id }));
  // 员工 UUID 顺序对应 B→A，目标锁应始终对应 A→B；混合目标也验证 org:… < position:…。
  const ids: string[] = [];
  for (let index = 0; index < employees.length; index++) {
    const target = targets[1 - index]!;
    ids.push(
      await w.insertRecord({
        type: target.kind,
        targetId: target.id,
        successorId: employees[index]!.id,
        startDate: '2026-10-01',
      }),
    );
    await w.leave(employees[index]!);
  }
  await w.asTenant(async (tx) => {
    for (const t of targets)
      await tx.execute(sql`
      INSERT INTO succession_target_locks (tenant_id,target_kind,target_id)
      VALUES (${w.tenant.id}::uuid,${t.kind},${t.id}::uuid) ON CONFLICT DO NOTHING`);
    await EXIT_SWEEP_PRODUCER.runTenant(tx, w.tenant, now);
  });
  const [run] = rowsOf<{ id: string }>(
    await w.asTenant((tx) =>
      tx.execute(sql`
    SELECT id FROM succession_calc_runs WHERE tenant_id=${w.tenant.id}::uuid AND kind='exit_sweep'`),
    ),
  );
  if (retry) {
    const blocked: CalcHandler = {
      ...actual(),
      authorizePage: async () => {
        throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
      },
    };
    expect(await runCalcPage(w.db, w.tenant.id, run!.id, [blocked], now)).toBe('blocked');
    const saved = rowsOf<{ revision: number }>(
      await w.asTenant((tx) =>
        tx.execute(sql`
      SELECT revision FROM succession_calc_runs WHERE id=${run!.id}::uuid`),
      ),
    )[0]!;
    await w.asTenant((tx) => changeCalcRun(tx, w.tenant.id, run!.id, saved.revision, 'retry', 'sc-page-retry', now));
  }
  const api = tenantApi(w.db, { clock: () => now });
  const as = { user: w.user.id, tenant: w.tenant.id };
  const end = () =>
    api.request('POST', '/api/tenant/succession/records/end', {
      ...as,
      body: { items: ids.map((id) => ({ id, expectedRevision: 1 })), endDate: '2026-10-02', endReason: '人工结束' },
    });
  const edit = () =>
    api.request('PUT', `/api/tenant/succession/records/${ids[1]}`, {
      ...as,
      ifMatch: 1,
      body: { backupType: 'deputy' },
    });
  const page = (handler: CalcHandler = actual()) =>
    runCalcPage(w.db, w.tenant.id, run!.id, defineCalcKinds([handler]), now);
  const state = () => Promise.all(ids.map(w.read));
  const runState = async () =>
    rowsOf<{ block_reason: string | null; attempt_no: number }>(
      await w.asTenant((tx) =>
        tx.execute(sql`
      SELECT block_reason,attempt_no FROM succession_calc_runs WHERE id=${run!.id}::uuid`),
      ),
    )[0]!;
  return { ...w, ids, targets, end, edit, page, state, runState };
}

/** 只在实际第一名员工执行完之后暂停；锁准备和记录处理都走生产 handler。 */
function afterFirst() {
  let reached!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((r) => (reached = r));
  const gate = new Promise<void>((r) => (release = r));
  let count = 0;
  const handler: CalcHandler = {
    ...actual(),
    async execute(ctx, object) {
      const result = await actual().execute(ctx, object);
      if (++count === 1) {
        reached();
        await gate;
      }
      return result;
    },
  };
  return { handler, ready, release };
}
async function holdTarget(w: ExitWorld, target: Target) {
  let reached!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((r) => (reached = r));
  const gate = new Promise<void>((r) => (release = r));
  const done = w.asTenant(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM succession_target_locks
      WHERE tenant_id=${w.tenant.id}::uuid AND target_kind=${target.kind} AND target_id=${target.id}::uuid FOR UPDATE`);
    reached();
    await gate;
  });
  await ready;
  return async () => {
    release();
    await done;
  };
}

pg('AC-SC-02 多员工页与 A2 写入口交错（PG）', () => {
  it.each([false, true])(
    'sweep 先到，混合目标=%s：第一名已写，批量结束等待；整页成功，无 500 / 死锁',
    async (mixed) => {
      const w = await world(mixed);
      const barrier = afterFirst();
      const sweeping = w.page(barrier.handler);
      expect(await Promise.race([barrier.ready.then(() => true), sweeping.then(() => false)])).toBe(true);
      const ending = w.end();
      let waiting: string;
      try {
        waiting = await settledOrBlocked(w.db, ending, 1);
      } finally {
        barrier.release();
      }
      const [status, response] = await Promise.all([sweeping, ending]);
      expect(waiting).toBe('blocked');
      expect(status).toBe('succeeded');
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({ error: { details: { reason: 'ALREADY_ENDED' } } });
      for (const row of await w.state()) expect(row).toMatchObject({ end_source: 'exit', revision: 2 });
      expect((await w.runState()).block_reason).toBeNull();
    },
  );
  it.each([false, true])('批量结束先到，混合目标=%s：HR 持 A 等 B，sweep 等待后全页不覆盖人工结果', async (mixed) => {
    const w = await world(mixed);
    const release = await holdTarget(w, w.targets[1]!);
    const ending = w.end();
    let sweeping!: ReturnType<typeof w.page>;
    try {
      await waitForBlocked(w.db, 1);
      sweeping = w.page();
      await waitForBlocked(w.db, 2);
    } finally {
      await release();
    }
    const [response, status] = await Promise.all([ending, sweeping]);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(status).toBe('succeeded');
    for (const row of await w.state())
      expect(row).toMatchObject({ end_source: 'manual', end_reason: '人工结束', revision: 2 });
    expect((await w.runState()).block_reason).toBeNull();
  });
  it.each([false, true])(
    'sweep 与单条编辑，混合目标=%s：第一名结束后，第二目标的编辑仍须等待全页提交',
    async (mixed) => {
      const w = await world(mixed);
      const barrier = afterFirst();
      const sweeping = w.page(barrier.handler);
      expect(await Promise.race([barrier.ready.then(() => true), sweeping.then(() => false)])).toBe(true);
      const editing = w.edit();
      let waiting: string;
      try {
        waiting = await settledOrBlocked(w.db, editing, 1);
      } finally {
        barrier.release();
      }
      const [status, response] = await Promise.all([sweeping, editing]);
      expect(waiting).toBe('blocked');
      expect(status).toBe('succeeded');
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
      for (const row of await w.state())
        expect(row).toMatchObject({ end_source: 'exit', revision: 2, backup_type: 'principal' });
    },
  );
  it('同一 blocked run 重试也准备整页锁，不能回到逐员工 B→A 路径', async () => {
    const w = await world(false, true);
    const barrier = afterFirst();
    const sweeping = w.page(barrier.handler);
    expect(await Promise.race([barrier.ready.then(() => true), sweeping.then(() => false)])).toBe(true);
    const ending = w.end();
    try {
      await waitForBlocked(w.db, 1);
    } finally {
      barrier.release();
    }
    const [status, response] = await Promise.all([sweeping, ending]);
    expect(status).toBe('succeeded');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ALREADY_ENDED' } } });
    expect(await w.runState()).toMatchObject({ attempt_no: 2, block_reason: null });
    for (const row of await w.state()) expect(row).toMatchObject({ end_source: 'exit', revision: 2 });
  });
});
