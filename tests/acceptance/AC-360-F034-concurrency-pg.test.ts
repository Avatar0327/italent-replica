/** F-034 R2：真实 PG 锁等待与 HTTP 交错，不允许确认替换后旧套卷作答复活。 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as context from '../../apps/api/src/modules/survey360/context.js';
import * as objectAnswers from '../../apps/api/src/modules/survey360/object-answers.js';
import { world360, type World360 } from './AC-360-support.js';

const testDb = useTestDb();
afterEach(() => vi.restoreAllMocks());

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForLock(db: Db, pattern: string, finished: () => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (finished()) throw new Error('写请求未等待真实数据库锁');
    const waiting = context.rows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n
      FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND query ILIKE ${pattern}`),
    );
    if (waiting[0]!.n > 0) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('未观测到写请求的真实锁等待');
}

async function fixture(label: string) {
  const w = await world360(testDb().db, label);
  const old = await w.enableQuestionnaire(await w.keyBehavior());
  const next = await w.enableQuestionnaire(await w.keyBehavior());
  const activity = await w.activity();
  const object = await w.object(activity.id, (await w.person('交错对象')).id, [old.id]);
  const a = await w.person('评价者甲');
  const b = await w.person('评价者乙');
  const relationA = await w.appraiser(activity.id, object.id, a.id, 'superior');
  const relationB = await w.appraiser(activity.id, object.id, b.id, 'peer');
  await w.transition(activity.id, 'enable');
  const tokenA = await w.token(activity.id, a.id);
  const tokenB = await w.token(activity.id, b.id);
  await w.ok((await w.answer(tokenA, relationA.id, old, ['v4', 'v4'])) as Response);
  const path = '/tasks/' + relationB.id + '/questionnaires/' + old.id;
  const answers = old.questions.map((q) => ({
    itemId: q.id,
    optionId: old.scales[0]!.options.find((o) => o.key === 'v3')!.id,
  }));
  const saveKey = randomUUID();
  const save = () => w.link(tokenB)('PUT', path, { ifMatch: 0, idempotencyKey: saveKey, body: { answers } });
  const replace = () =>
    w.request('PUT', '/activities/' + activity.id + '/objects/' + object.id + '/questionnaires', {
      ifMatch: object.revision,
      body: { questionnaireIds: [next.id], confirmClearAnswers: true },
    });
  return { w, old, next, activity, object, b, relationB, tokenB, path, saveKey, save, replace };
}

async function counts(w: World360, activityId: string, qid: string) {
  return withTenant(
    w.db,
    w.tenantId,
    async (tx) =>
      context.rows<{ sheets: number; answers: number }>(
        await tx.execute(sql`SELECT
      (SELECT count(*)::int FROM survey360_sheets WHERE activity_id = ${activityId} AND questionnaire_id = ${qid})
        AS sheets,
      (SELECT count(*)::int FROM survey360_answers a JOIN survey360_sheets s
        ON s.tenant_id = a.tenant_id AND s.id = a.sheet_id
        WHERE s.activity_id = ${activityId} AND s.questionnaire_id = ${qid}) AS answers`),
      )[0]!,
  );
}

async function assertRejected(f: Awaited<ReturnType<typeof fixture>>, response: Response) {
  const remaining = await counts(f.w, f.activity.id, f.old.id);
  const observed = { response: await response.clone().text(), remaining };
  expect(response.status, JSON.stringify(observed)).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  expect(remaining).toEqual({ sheets: 0, answers: 0 });
  expect((await f.w.link(f.tokenB)('GET', f.path)).status).toBe(404);
  const audit = await withTenant(f.w.db, f.w.tenantId, (tx) =>
    tx.execute(sql`SELECT id FROM audit_events
    WHERE command_id = ${f.saveKey} AND action IN ('survey360.sheet.save', 'survey360.sheet.submit')`),
  );
  expect(context.rows(audit)).toEqual([]);
}

/** 真实锁屏障只延后事务释放；任何失败路径也须结束占用连接的事务。 */
function hold(db: Db, tenantId: string, lock: ReturnType<typeof sql>) {
  const reached = signal();
  const release = signal();
  const promise = withTenant(db, tenantId, async (tx) => {
    await tx.execute(lock);
    reached.resolve();
    await release.promise;
  });
  return { reached, release, promise };
}

async function reachedBeforeFinish(reached: ReturnType<typeof signal>, request: Promise<unknown>) {
  await Promise.race([
    reached.promise,
    request.then(() => {
      throw new Error('请求未到持锁屏障');
    }),
  ]);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-360-F034 真实 PG 替换与作答交错', () => {
  it('A 已提交；B 首次保存等待评价者锁；确认替换提交后 B 必须 404，旧答卷和答案不复活', async () => {
    const f = await fixture('f034-pg-appraiser');
    const lockKey = f.w.tenantId + ':survey360-answer:' + f.activity.id + ':' + f.b.id;
    const gate = hold(f.w.db, f.w.tenantId, sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    let save: Promise<Response> | undefined;
    try {
      await reachedBeforeFinish(gate.reached, gate.promise);
      let finished = false;
      save = f.save().finally(() => {
        finished = true;
      });
      await waitForLock(f.w.db, '%pg_advisory_xact_lock%', () => finished);
      await f.w.ok(f.replace());
      expect(await counts(f.w, f.activity.id, f.old.id)).toEqual({ sheets: 0, answers: 0 });
      gate.release.resolve();
      await assertRejected(f, await save);
      // 原命令重提不能复活旧任务；原链接仍可作答新套卷。
      await assertRejected(f, await f.save());
      await f.w.ok((await f.w.answer(f.tokenB, f.relationB.id, f.next, ['v3', 'v3'])) as Response);
    } finally {
      gate.release.resolve();
      await Promise.allSettled([gate.promise, ...(save ? [save] : [])]);
    }
  });

  it('替换已清空但未提交；B 首次保存真实等待；替换提交后 B 必须重新校验并拒绝', async () => {
    const f = await fixture('f034-pg-replace-first');
    const reached = signal();
    const release = signal();
    const original = objectAnswers.clearObjectAnswers;
    vi.spyOn(objectAnswers, 'clearObjectAnswers').mockImplementationOnce(async (...args) => {
      await original(...args);
      reached.resolve();
      await release.promise;
    });
    const replace = f.replace();
    let save: Promise<Response> | undefined;
    try {
      await reachedBeforeFinish(reached, replace);
      let finished = false;
      save = f.save().finally(() => {
        finished = true;
      });
      await waitForLock(f.w.db, '%survey360_%', () => finished);
      release.resolve();
      const [replaced, saved] = await Promise.all([replace, save]);
      await f.w.ok(replaced);
      await assertRejected(f, saved);
    } finally {
      release.resolve();
      await Promise.allSettled([replace, ...(save ? [save] : [])]);
    }
  });

  it('B 保存持锁未提交；替换等待保存提交后清空 A 与 B，无死锁或旧作答残留', async () => {
    const f = await fixture('f034-pg-save-first');
    const reached = signal();
    const release = signal();
    const original = context.audit360;
    vi.spyOn(context, 'audit360').mockImplementation(async (...args) => {
      await original(...args);
      if (args[2].action === 'survey360.sheet.save') {
        reached.resolve();
        await release.promise;
      }
    });
    const save = f.save();
    let replace: Promise<Response> | undefined;
    try {
      await reachedBeforeFinish(reached, save);
      let finished = false;
      replace = f.replace().finally(() => {
        finished = true;
      });
      await waitForLock(f.w.db, '%survey360_activities%', () => finished);
      release.resolve();
      const [saved, replaced] = await Promise.all([save, replace]);
      await f.w.ok(saved);
      await f.w.ok(replaced);
      expect(await counts(f.w, f.activity.id, f.old.id)).toEqual({ sheets: 0, answers: 0 });
      const deleted = await withTenant(f.w.db, f.w.tenantId, (tx) =>
        tx.execute(sql`SELECT id FROM audit_events
        WHERE action = 'survey360.sheet.delete' AND before->>'activityId' = ${f.activity.id}`),
      );
      expect(context.rows(deleted)).toHaveLength(2);
    } finally {
      release.resolve();
      await Promise.allSettled([save, ...(replace ? [replace] : [])]);
    }
  });
});
