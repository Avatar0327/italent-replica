/**
 * F-084 第 1 轮 P2-1：有效关系检查与实际读写之间的撤销竞态（真 PostgreSQL；PGlite 单连接无法并发）。
 * - 读侧：resolve 的 EXISTS 通过之后关系被撤销，作答页 / 头像名单不能再返回“活动信息 + 空任务”这种不对应任何串行状态
 *   的结果——授权判断与返回数据同源，空任务按“无有效关系”拒绝（直接调用页面组装函数，状态 = 检查通过后关系已被删）。
 * - 写侧：确认链接删除评价关系不锁活动，与评价者保存 / 提交并发时，作答写入必须在取得保护写入的锁（关系行 → 对象行）
 *   之后重新校验关系仍有效。屏障：测试侧事务卡住其中一方，另一方的位置只能是“排在后面”，结果必须等价于某一串行顺序。
 *   · 顺序 A（先作答后删除）：作答已持锁卡在答卷行上，确认人删除必须排队等它，提交后作答 200、关系随后被删；
 *   · 顺序 B（先删除后作答）：删除已删掉关系卡在后续写入上，作答必须排在后面，放行后 404、答卷不变。
 */
import { type Db, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { answerPage, avatarPersonIds } from '../../apps/api/src/modules/survey360/answering.js';
import { key, my, sceneB, type SceneB, type TodoView } from './AC-360-B-support.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PENDING = Symbol('pending');

/** 现在在行锁 / 事务锁上等待的后端数。 */
async function lockWaiters(db: Db): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`),
  );
  return Number(row?.n);
}

async function waitForWaiters(db: Db, expected: number, patience = 4000) {
  for (let waited = 0; waited < patience; waited += 25) {
    if ((await lockWaiters(db)) >= expected) return true;
    await sleep(25);
  }
  return false;
}

/** 等 promise 最多 ms：没完成返回 PENDING（用来断言“还排在队列里”）。 */
const settledWithin = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, sleep(ms).then(() => PENDING as typeof PENDING)]);

type Op = 'PUT' | 'POST';
type EntryName = 'link' | 'todo';

async function raceScene(label: string, entryName: EntryName, op: Op) {
  const s = await sceneB(testDb().db, label);
  const { w } = s;
  // 评价者 P1 先存一份完整草稿（保存 / 提交都有现成的答卷行可锁）
  await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v4', 'v4'], { submit: false });
  const taskPath = `/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`;
  const options = s.q.scales[0]!.options;
  const answers = s.q.questions.map((x) => ({ itemId: x.id, optionId: options.find((o) => o.key === 'v3')!.id }));
  const sheet = await currentSheet(s);
  let call: (method: string, path: string, opts?: Record<string, unknown>) => Promise<Response>;
  if (entryName === 'link') {
    call = w.link(await w.token(s.activity.id, s.person.P1.id));
  } else {
    await w.ok(w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P1.id] } }));
    const todo = (await w.ok<{ items: TodoView[] }>(my(w, s.user.P1)('GET', '/todos'))).items[0]!;
    const mine = my(w, s.user.P1);
    call = (method, path, opts) => mine(method, `/todos/${todo.id}${path}`, opts);
  }
  const attempt = () =>
    op === 'PUT'
      ? call('PUT', taskPath, { ifMatch: sheet.revision, body: { answers } })
      : call('POST', `${taskPath}/submit`, { ifMatch: sheet.revision });

  // 确认人（M）经确认链接删除 P1 的评价关系（该路径不锁活动）
  await w.ok(w.request('POST', `${s.path}/objects/${s.object.id}/confirmation`, { ifMatch: 0, body: {} }), 201);
  const confirm = w.link(await w.token(s.activity.id, s.person.M.id, 'survey360.confirm_invitation'));
  const confirmation = await w.ok<{ revision: number }>(confirm('GET', ''));
  const removeByConfirmer = () =>
    confirm('DELETE', `/confirmation/appraisers/${s.rel.p1.id}`, { ifMatch: confirmation.revision });
  return { s, sheet, attempt, removeByConfirmer, db: testDb().db };
}

async function currentSheet(s: SceneB) {
  const [row] = rowsOf<{ id: string; revision: number; status: string }>(
    await withTenant(testDb().db, s.w.tenantId, (tx) =>
      tx.execute(sql`SELECT id, revision, status FROM survey360_sheets WHERE relation_id = ${s.rel.p1.id}::uuid`),
    ),
  );
  return row!;
}

const relationRemoved = async (s: SceneB) => {
  const [row] = rowsOf<{ removed: boolean }>(
    await withTenant(testDb().db, s.w.tenantId, (tx) =>
      tx.execute(sql`SELECT removed FROM survey360_relations WHERE id = ${s.rel.p1.id}::uuid`),
    ),
  );
  return row!.removed;
};

describe('F-084 读侧：检查通过后关系被撤销，页面与头像名单不返回“活动信息 + 空任务”', () => {
  it('作答页组装与头像名单在没有有效任务时按“无有效关系”拒绝（授权与数据同源）', async () => {
    const s = await sceneB(testDb().db, 'f84-read-race');
    const { w } = s;
    const link = {
      id: crypto.randomUUID(),
      activityId: s.activity.id,
      kind: 'answer' as const,
      personId: s.person.P1.id,
      confirmationId: null,
    };
    const run = <T>(work: (tx: Tx, activity: never) => Promise<T>) =>
      withTenant(testDb().db, w.tenantId, async (tx) => {
        const [activity] = rowsOf(
          await tx.execute(sql`SELECT * FROM survey360_activities WHERE id = ${s.activity.id}::uuid`),
        );
        return work(tx, activity as never);
      });
    // 仍有关系：页面与头像名单正常
    const page = await run((tx, activity) => answerPage(tx, link, activity, '/base'));
    expect(page.tasks).toHaveLength(1);
    expect(await run((tx, activity) => avatarPersonIds(tx, link, activity))).toContain(s.person.P1.id);
    // 关系在 resolve 通过之后被撤销：直接组装的页面 / 名单必须拒绝，不能返回 200 + 活动信息 + tasks: []
    const offset = await w.ok<{ items: { id: string; revision: number }[] }>(
      w.request('GET', `${s.path}/objects/${s.object.id}/appraisers`),
    );
    const mine = offset.items.find((r) => r.id === s.rel.p1.id)!;
    await w.ok(
      w.request('DELETE', `${s.path}/objects/${s.object.id}/appraisers/${s.rel.p1.id}`, { ifMatch: mine.revision }),
    );
    await expect(run((tx, activity) => answerPage(tx, link, activity, '/base'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(run((tx, activity) => avatarPersonIds(tx, link, activity))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe.runIf(realPostgres).each([
  ['link', 'PUT'],
  ['link', 'POST'],
  ['todo', 'PUT'],
  ['todo', 'POST'],
] as const)('F-084 写侧：确认链接删除关系 × 评价者作答（入口 %s，%s）', (entryName, op) => {
  it('顺序 A：作答先持锁，确认人删除必须排在它后面——作答 200，关系随后才被删', async () => {
    const r = await raceScene(`f84-race-a-${entryName}-${op}`, entryName, op);
    const outcome = await withTenant(r.db, r.s.w.tenantId, async (holder) => {
      // 测试侧先锁住答卷行：作答过了关系 / 对象校验后停在这里
      await holder.execute(sql`SELECT 1 FROM survey360_sheets WHERE id = ${r.sheet.id}::uuid FOR UPDATE`);
      const attempt = r.attempt();
      expect(await waitForWaiters(r.db, 1)).toBe(true);
      const removal = r.removeByConfirmer();
      // 删除若不需要等作答持有的锁，就会在这里直接完成（新旧锁序的分界）
      const early = await settledWithin(removal, 1500);
      return { attempt, removal, early };
    });
    expect(outcome.early, '确认人删除没有排在已通过校验的作答后面').toBe(PENDING);
    expect((await outcome.attempt).status).toBe(200);
    expect((await outcome.removal).status).toBe(200);
    expect(await relationRemoved(r.s)).toBe(true);
  });

  it('顺序 B：删除先摘掉关系并卡在后续写入上，作答排在它后面——放行后 404，答卷不变', async () => {
    const r = await raceScene(`f84-race-b-${entryName}-${op}`, entryName, op);
    const before = await currentSheet(r.s);
    const outcome = await withTenant(r.db, r.s.w.tenantId, async (holder) => {
      // 测试侧锁住评价对象行：确认人删除改完关系后，更新对象的报告标记时停在这里
      await holder.execute(sql`SELECT 1 FROM survey360_objects WHERE id = ${r.s.object.id}::uuid FOR UPDATE`);
      const removal = r.removeByConfirmer();
      expect(await waitForWaiters(r.db, 1)).toBe(true);
      const attempt = r.attempt();
      await waitForWaiters(r.db, 2, 1500);
      return { removal, attempt };
    });
    expect((await outcome.removal).status).toBe(200);
    const result = await outcome.attempt;
    expect(result.status, await result.clone().text()).toBe(404);
    expect(await relationRemoved(r.s)).toBe(true);
    expect(await currentSheet(r.s)).toEqual(before);
  });
});
