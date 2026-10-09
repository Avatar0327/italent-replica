/**
 * AC-TR-08-matrix-deadlock-pg · 位置字段占用的锁协议（真 PG；PGlite 单连接无法并发）。
 * - PR #182 第 1 轮 P2-01：两个九宫格互换对方占用的位置字段，各自先删旧占用再插新占用 → 40P01 死锁（500）；
 * - 第 2 轮 P2：预置补装两个预置分批取锁，第二批可能取更小的字段 → 与租户 PATCH / POST 交错成咨询锁死锁环。
 * 统一锁协议（matrix-service.ts lockPositionFields）：所有写位置字段占用的事务，在任何写入之前一次性按排序取齐
 * 本事务涉及的全部位置字段的占用锁。屏障停在“占用锁 / 删插”阶段并断言等待的锁类型，证明交错确实发生在那里。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { positionLockKey } from '../../apps/api/src/modules/talent-review/matrix-service.js';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { TR_NOW } from './AC-TR-config-support.js';
import { MATRICES, matrixBody, matrixWorld, type MatrixView } from './AC-TR-matrix-support.js';
import { rowsOf } from './support/f048.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
type Role = 'before' | 'after';
const fieldOf = (m: MatrixView, role: Role) => m.positionFields.find((row) => row.role === role)!.fieldId;
const other = (role: Role): Role => (role === 'before' ? 'after' : 'before');

/** 正在等锁的会话，按等待事件计数（advisory = 咨询锁，transactionid = 等另一事务结束，如唯一索引上的未提交行）。 */
async function lockWaits(db: Db): Promise<Record<string, number>> {
  const rows = rowsOf<{ event: string; n: number }>(
    await db.execute(sql`SELECT wait_event AS event, count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' GROUP BY wait_event`),
  );
  return Object.fromEntries(rows.map((row) => [row.event, Number(row.n)]));
}
async function waitForWaits(db: Db, expected: Record<string, number>) {
  let last: Record<string, number> = {};
  for (let i = 0; i < 200; i += 1) {
    last = await lockWaits(db);
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等锁状态没有到达 ${JSON.stringify(expected)}，最后一次是 ${JSON.stringify(last)}`);
}

/** 屏障事务：回调里放行并发请求，结束时回滚（不提交屏障做的任何事）。 */
async function underBarrier<T>(db: Db, tenantId: string, hold: (tx: Tx) => Promise<T>) {
  const rollback = new Error('barrier-rollback');
  let result: T | undefined;
  await withTenant(db, tenantId, async (tx) => {
    result = await hold(tx);
    throw rollback;
  }).catch((error: unknown) => {
    if (error !== rollback) throw error;
  });
  return result as T;
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('位置字段占用锁协议 · PostgreSQL 16', () => {
  it.each([
    ['before↔before', 'before', 'before'],
    ['after↔after', 'after', 'after'],
    ['before↔after', 'before', 'after'],
    ['after↔before', 'after', 'before'],
  ] as const)(
    '两个九宫格互换对方的位置字段 · %s：两者都在占用锁上排队，结果 409 + 409，无死锁、完整回滚',
    async (_n, x, y) => {
      const w = await matrixWorld(testDb().db, `trm-dl-${x}-${y}`);
      const a = await w.create();
      const b = await w.create();
      // 真正的角色互换：A 的 x 角色拿 B 的 y 角色字段，B 的 y 角色拿 A 的 x 角色字段（第 1 轮复现的目标）
      const takeA = fieldOf(b, y);
      const takeB = fieldOf(a, x);
      const patch = (m: MatrixView, role: Role, taken: string) =>
        w.request('PATCH', `${MATRICES}/${m.id}`, {
          ifMatch: 1,
          body: {
            positionFields: [
              { role, fieldId: taken },
              { role: other(role), fieldId: fieldOf(m, other(role)) },
            ],
          },
        });
      const responses = await underBarrier(testDb().db, w.as.tenant, async (tx) => {
        for (const id of [takeA, takeB])
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${positionLockKey(w.as.tenant, id)})`);
        const pending = [patch(a, x, takeA), patch(b, y, takeB)];
        // 两个修改都已过行锁、停在占用锁（咨询锁）上，删插还没开始
        await waitForWaits(testDb().db, { advisory: 2 });
        return pending;
      });
      const settled = await Promise.all(responses);
      for (const response of settled) expect([response.status, await errorCode(response)]).toEqual([409, 'CONFLICT']);
      const now = [(await w.read(a.id)).body, (await w.read(b.id)).body];
      expect(now.map((m) => m.revision)).toEqual([1, 1]);
      expect(now.map((m) => m.positionFields)).toEqual([a.positionFields, b.positionFields]);
    },
  );

  it('两个新建同时按相反顺序占用同一对位置字段：一成一败（409），无死锁', async () => {
    const w = await matrixWorld(testDb().db, 'trm-dl-create');
    const f1 = (await w.positionField()).id;
    const f2 = (await w.positionField()).id;
    const build = async (before: string, after: string) => matrixBody({ ...(await w.refs()), before, after });
    const [c1, c2] = await Promise.all([build(f1, f2), build(f2, f1)]);
    const responses = await Promise.all([w.post(c1), w.post(c2)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

/**
 * 预置位置字段换成有序的标识：第一个预置（业绩-能力）的排在最后，第二个预置（绩效-潜力）的排在最前，构成“第二批取更小 ID”。
 * 字段主键全库唯一，每个用例的尾段随机。
 */
const presetIds = () => {
  const tail = () => randomUUID().slice(-12);
  return {
    achievement_capability_cell_before: `ffffffff-ffff-4fff-bfff-${tail()}`,
    achievement_capability_cell_after: `ffffffff-ffff-4fff-bfff-${tail()}`,
    appraisal_potential_cell_before: `00000000-0000-4000-8000-${tail()}`,
    appraisal_potential_cell_after: `00000000-0000-4000-8000-${tail()}`,
  } as Record<string, string>;
};

/** 存量租户：已有预置字段、还没有预置九宫格；预置位置字段换成固定标识（成对字段先解开再接回）。 */
async function legacyTenant(label: string) {
  const db = testDb().db;
  const w = await matrixWorld(db, label);
  const ids = presetIds();
  const write = { tenantId: w.as.tenant, actorUserId: null, now: TR_NOW, commandId: `${label}-seed` };
  await withTenant(db, w.as.tenant, (tx) => installMissingSeeds(tx, write, { modules: ['talent-review'] }));
  await withTenant(db, w.as.tenant, async (tx) => {
    await tx.execute(sql`DELETE FROM talent_review_matrices`);
    const codes = Object.keys(ids);
    await tx.execute(sql`UPDATE talent_review_fields SET pair_field_id = NULL WHERE code IN ${codes}`);
    for (const [code, id] of Object.entries(ids)) {
      await tx.execute(sql`UPDATE talent_review_fields SET id = ${id}::uuid WHERE code = ${code}`);
    }
    for (const [code, id] of Object.entries(ids)) {
      const partner = code.endsWith('_before')
        ? code.replace(/_before$/, '_after')
        : code.replace(/_after$/, '_before');
      await tx.execute(
        sql`UPDATE talent_review_fields SET pair_field_id = ${ids[partner]}::uuid WHERE id = ${id}::uuid`,
      );
    }
  });
  const backfill = () =>
    withTenant(db, w.as.tenant, (tx) =>
      installMissingSeeds(
        tx,
        { ...write, commandId: `${label}-backfill-${randomUUID()}` },
        { modules: ['talent-review'] },
      ),
    );
  return { w, backfill, ids };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  '预置补装 × 租户占用位置字段 · PostgreSQL 16（第 2 轮 P2）',
  () => {
    it.each(['PATCH', 'POST'] as const)(
      '补装先取齐全部占用锁后停在写九宫格，%s 选两个预置各一个位置字段：只在占用锁上排队，补装完成后 409，无死锁',
      async (method) => {
        const { w, backfill, ids } = await legacyTenant(`trm-dl-seed-${method}`);
        const own = method === 'PATCH' ? await w.create() : undefined;
        const fields = {
          before: ids.appraisal_potential_cell_before!,
          after: ids.achievement_capability_cell_after!,
        };
        const occupy = () =>
          own
            ? w.request('PATCH', `${MATRICES}/${own.id}`, {
                ifMatch: 1,
                body: {
                  positionFields: [
                    { role: 'before', fieldId: fields.before },
                    { role: 'after', fieldId: fields.after },
                  ],
                },
              })
            : w.refs().then((refs) => w.post(matrixBody({ ...refs, ...fields })));
        const refs = await w.refs();
        const { seeding, occupying } = await underBarrier(testDb().db, w.as.tenant, async (tx) => {
          // 屏障：未提交的同编码九宫格，让补装停在插入第一个预置九宫格（唯一索引等本事务结束）
          const name = `屏障${randomUUID()}`;
          await tx.execute(sql`INSERT INTO talent_review_matrices (tenant_id, code, name, x_field_id, y_field_id)
            VALUES (${w.as.tenant}::uuid, 'achievement_capability', ${name}, ${refs.x}::uuid, ${refs.y}::uuid)`);
          const seeding = backfill();
          await waitForWaits(testDb().db, { transactionid: 1 });
          const occupying = occupy();
          await waitForWaits(testDb().db, { advisory: 1, transactionid: 1 });
          return { seeding, occupying };
        });
        const report = (await seeding).find((item) => item.key === 'preset-matrices')!;
        expect(report.installed).toEqual(['achievement_capability', 'appraisal_potential']);
        const response = await occupying;
        expect([response.status, await errorCode(response)]).toEqual([409, 'CONFLICT']);
        if (own) expect((await w.read(own.id)).body).toMatchObject({ revision: 1, positionFields: own.positionFields });
      },
    );
  },
);
