/**
 * F-053（#107 PR-A3 第 5 轮自检疑点 c，DEC-319③）：编辑“已使用的套卷”与“重新启用活动”并发。
 * 真实 PG 交错：编辑先持锁、启用先持锁、编辑与评价者保存 / 提交在重新启用前后交错，断言计分、作答与审计一致。
 * 不变量（25 §3.1 E3-R2）：套卷被编辑的提交点，不得有任何用到它的活动处于启用状态；启用校验看到的内容就是启用时的内容。
 */
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as context from '../../apps/api/src/modules/survey360/context.js';
import { overall, type QuestionnaireView, type World360, world360 } from './AC-360-support.js';

const testDb = useTestDb();
afterEach(() => vi.restoreAllMocks());

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 请求要么在真实数据库锁上等待（返回 'blocked'），要么已经结束（返回响应，说明两条路径没有被串行化）。 */
async function blockedOrDone(db: Db, pattern: string, request: Promise<Response>): Promise<'blocked' | Response> {
  let done: Response | undefined;
  void request.then((res) => {
    done = res;
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (done) return done;
    const waiting = context.rows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`),
    );
    if (waiting[0]!.n > 0) return 'blocked';
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('请求既未结束也未观测到真实锁等待');
}

/** 命令在 audit360 处暂停：此时业务写入已完成、事务未提交，持有的锁仍在。 */
function pauseAt(action: string) {
  const reached = signal();
  const release = signal();
  const original = context.audit360;
  vi.spyOn(context, 'audit360').mockImplementation(async (...args) => {
    await original(...args);
    if (args[2].action === action) {
      reached.resolve();
      await release.promise;
    }
  });
  return { reached, release };
}

async function started(reached: ReturnType<typeof signal>, request: Promise<Response>) {
  await Promise.race([
    reached.promise,
    request.then((res) => {
      throw new Error('请求未到暂停点：' + res.status);
    }),
  ]);
}

async function expectBlocked(db: Db, request: Promise<Response>) {
  const outcome = await blockedOrDone(db, '%survey360_questionnaires%', request);
  expect(outcome === 'blocked' ? 'blocked' : `未等待套卷锁，已返回 ${outcome.status}`).toBe('blocked');
}

const EDIT_TEXT = '主动沟通（修订）';

/** 他评套卷：上级 / 同事等角色同 AC-360-03；q1 权重改 3 后，上级 v4 + v2 的角色分 3.0 → 3.5。 */
async function questionnaireOf(w: World360, used: boolean) {
  const q = await w.enableQuestionnaire(await w.keyBehavior());
  const activity = await w.activity();
  const target = await w.person('评价对象');
  const object = await w.object(activity.id, target.id, [q.id]);
  const a = await w.person('评价者甲');
  const b = await w.person('评价者乙');
  const relationA = await w.appraiser(activity.id, object.id, a.id, 'superior');
  const relationB = await w.appraiser(activity.id, object.id, b.id, 'peer');
  const ctx = { q, activity, object, a, b, relationA, relationB };
  if (!used) return ctx;
  await w.transition(activity.id, 'enable');
  const tokenA = await w.token(activity.id, a.id);
  const done = await w.answer(tokenA, relationA.id, q, ['v4', 'v2']);
  await w.ok(done as Response);
  await w.transition(activity.id, 'disable'); // 套卷已使用、活动已停用，等待“重新启用”
  return ctx;
}

const get = (w: World360, id: string) =>
  w.ok<QuestionnaireView & { revision: number }>(w.request('GET', `/questionnaires/${id}`));

function editContent(w: World360, q1Weight: number, withoutRole?: string) {
  const content = w.keyBehaviorContent({ self: 0, superior: 5, peer: 3, subordinate: 2 });
  return {
    ...content,
    roles: content.roles.filter((r) => r.key !== withoutRole),
    questions: [{ ...content.questions[0]!, text: EDIT_TEXT, weight: q1Weight }, content.questions[1]!],
  };
}

async function edit(w: World360, id: string, content: ReturnType<typeof editContent>) {
  const current = await get(w, id);
  return w.request('PUT', `/questionnaires/${id}`, { ifMatch: current.revision, body: { content } });
}

async function enable(w: World360, activityId: string) {
  const current = await w.getActivity(activityId);
  return w.request('POST', `/activities/${activityId}/enable`, { ifMatch: current.revision });
}

async function snapshot(w: World360, ctx: Awaited<ReturnType<typeof questionnaireOf>>) {
  const q = await get(w, ctx.q.id);
  const activity = await w.getActivity(ctx.activity.id);
  const counts = await withTenant(w.db, w.tenantId, async (tx) =>
    context.rows<{ sheets: number; submitted: number; answers: number; batches: number }>(
      await tx.execute(sql`SELECT
        (SELECT count(*)::int FROM survey360_sheets WHERE activity_id = ${ctx.activity.id}) AS sheets,
        (SELECT count(*)::int FROM survey360_sheets WHERE activity_id = ${ctx.activity.id} AND status = 'submitted')
          AS submitted,
        (SELECT count(*)::int FROM survey360_answers an JOIN survey360_sheets s
          ON s.tenant_id = an.tenant_id AND s.id = an.sheet_id WHERE s.activity_id = ${ctx.activity.id}) AS answers,
        (SELECT count(*)::int FROM survey360_score_batches WHERE activity_id = ${ctx.activity.id}) AS batches`),
    ),
  );
  return { text: q.questions[0]!.text, status: q.status, activity: activity.status, ...counts[0]! };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-360-F053 真实 PG：已使用套卷编辑 × 重新启用活动', () => {
  it('编辑先持锁（已过“无启用活动”检查、未提交）：重新启用必须等编辑提交；两者先后成功，计分用修订后的权重', async () => {
    const w = await world360(testDb().db, 'f053-edit-first');
    const ctx = await questionnaireOf(w, true);
    const gate = pauseAt('survey360.questionnaire.update');
    const editing = edit(w, ctx.q.id, editContent(w, 3));
    let enabling: Promise<Response> | undefined;
    try {
      await started(gate.reached, editing);
      enabling = enable(w, ctx.activity.id);
      const outcome = await blockedOrDone(w.db, '%survey360_questionnaires%', enabling);
      expect(
        outcome === 'blocked' ? 'blocked' : `重新启用未等待编辑提交，已返回 ${outcome.status}`,
        '编辑未提交时活动已被启用 → 启用的校验与套卷内容脱节',
      ).toBe('blocked');
      gate.release.resolve();
      await w.ok(editing);
      await w.ok(enabling);
      expect(await snapshot(w, ctx)).toMatchObject({
        text: EDIT_TEXT,
        activity: 'enabled',
        sheets: 1,
        submitted: 1,
        answers: 2,
      });
      // 重新启用后评价者乙在修订后的套卷上保存并提交，停用后全部按修订后的权重重新计分
      const tokenB = await w.token(ctx.activity.id, ctx.b.id);
      await w.ok((await w.answer(tokenB, ctx.relationB.id, await get(w, ctx.q.id), ['v3', 'v3'])) as Response);
      await w.transition(ctx.activity.id, 'disable');
      const rows = await w.scores(ctx.activity.id, ctx.object.id);
      expect(overall(rows, 'role', w.role('superior'))).toBeCloseTo(3.5, 6); // (4×3 + 2×1) / 4
      expect(overall(rows, 'role', w.role('peer'))).toBeCloseTo(3, 6);
      expect(await snapshot(w, ctx)).toMatchObject({ sheets: 2, submitted: 2, answers: 4, batches: 2 });
    } finally {
      gate.release.resolve();
      await Promise.allSettled([editing, ...(enabling ? [enabling] : [])]);
    }
  });

  it('重新启用先持锁（校验与已使用标记已做、未提交）：编辑必须等启用提交，再被“活动启用中”拒绝，套卷与作答不变', async () => {
    const w = await world360(testDb().db, 'f053-enable-first');
    const ctx = await questionnaireOf(w, true);
    const before = await snapshot(w, ctx);
    const revision = (await get(w, ctx.q.id)).revision;
    const gate = pauseAt('survey360.activity.enable');
    const enabling = enable(w, ctx.activity.id);
    let editing: Promise<Response> | undefined;
    try {
      await started(gate.reached, enabling);
      editing = edit(w, ctx.q.id, editContent(w, 3));
      const outcome = await blockedOrDone(w.db, '%survey360_questionnaires%', editing);
      expect(
        outcome === 'blocked'
          ? 'blocked'
          : `编辑未等待启用提交，已返回 ${outcome.status}：${await outcome.clone().text()}`,
        '启用未提交时编辑已成功 → 活动启用中套卷被改',
      ).toBe('blocked');
      gate.release.resolve();
      await w.ok(enabling);
      const rejected = await editing;
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ error: { details: { reason: 'ACTIVITY_ENABLED' } } });
      const after = await snapshot(w, ctx);
      expect(after).toEqual({ ...before, activity: 'enabled' });
      expect((await get(w, ctx.q.id)).revision).toBe(revision);
      // 活动启用期间评价者乙按原套卷保存并提交；停用后计分仍用原权重
      const tokenB = await w.token(ctx.activity.id, ctx.b.id);
      await w.ok((await w.answer(tokenB, ctx.relationB.id, await get(w, ctx.q.id), ['v3', 'v3'])) as Response);
      await w.transition(ctx.activity.id, 'disable');
      const rows = await w.scores(ctx.activity.id, ctx.object.id);
      expect(overall(rows, 'role', w.role('superior'))).toBeCloseTo(3, 6); // (4 + 2) / 2
    } finally {
      gate.release.resolve();
      await Promise.allSettled([enabling, ...(editing ? [editing] : [])]);
    }
  });

  it('编辑先持锁期间：评价者保存被“活动未启用”拒绝且不留答卷；重新启用后保存 / 提交落在修订后的套卷上', async () => {
    const w = await world360(testDb().db, 'f053-rater');
    const ctx = await questionnaireOf(w, true);
    const tokenB = await w.token(ctx.activity.id, ctx.b.id);
    const path = `/tasks/${ctx.relationB.id}/questionnaires/${ctx.q.id}`;
    const answers = ctx.q.questions.map((q) => ({
      itemId: q.id,
      optionId: ctx.q.scales[0]!.options.find((o) => o.key === 'v3')!.id,
    }));
    const gate = pauseAt('survey360.questionnaire.update');
    const editing = edit(w, ctx.q.id, editContent(w, 3));
    let enabling: Promise<Response> | undefined;
    try {
      await started(gate.reached, editing);
      enabling = enable(w, ctx.activity.id);
      await expectBlocked(w.db, enabling);
      const early = await w.link(tokenB)('PUT', path, { ifMatch: 0, body: { answers } });
      expect(early.status).toBe(409);
      expect(await early.json()).toMatchObject({ error: { details: { reason: 'ACTIVITY_NOT_OPEN' } } });
      expect(await snapshot(w, ctx)).toMatchObject({ sheets: 1, answers: 2, activity: 'disabled' });
      gate.release.resolve();
      await w.ok(editing);
      await w.ok(enabling);
      const saved = await w.ok<{ revision: number }>(w.link(tokenB)('PUT', path, { ifMatch: 0, body: { answers } }));
      await w.ok(w.link(tokenB)('POST', `${path}/submit`, { ifMatch: saved.revision }));
      const page = await w.ok<{ questionnaire: { items: { text: string }[] } }>(w.link(tokenB)('GET', path));
      expect(page.questionnaire.items.map((i) => i.text)).toContain(EDIT_TEXT);
      expect(await snapshot(w, ctx)).toMatchObject({ sheets: 2, submitted: 2, answers: 4 });
    } finally {
      gate.release.resolve();
      await Promise.allSettled([editing, ...(enabling ? [enabling] : [])]);
    }
  });

  it('套卷已启用但还没被使用时同样：编辑删掉评价角色（未提交），活动启用必须按提交后的角色重新校验', async () => {
    const w = await world360(testDb().db, 'f053-first-use');
    const ctx = await questionnaireOf(w, false);
    const gate = pauseAt('survey360.questionnaire.update');
    const editing = edit(w, ctx.q.id, editContent(w, 1, 'peer'));
    let enabling: Promise<Response> | undefined;
    try {
      await started(gate.reached, editing);
      enabling = enable(w, ctx.activity.id);
      await expectBlocked(w.db, enabling);
      gate.release.resolve();
      await w.ok(editing);
      const rejected = await enabling;
      expect(rejected.status, '活动按编辑前的角色通过校验 → 启用后存在评价角色不在套卷里的关系').toBe(400);
      expect(await rejected.json()).toMatchObject({ error: { details: { reason: 'ROLE_NOT_IN_QUESTIONNAIRE' } } });
      expect(await snapshot(w, ctx)).toMatchObject({ activity: 'draft', status: 'enabled', sheets: 0 });
    } finally {
      gate.release.resolve();
      await Promise.allSettled([editing, ...(enabling ? [enabling] : [])]);
    }
  });

  it('两个活动共用一套卷同时启用并有编辑：不死锁、无 5xx，响应与最终状态一致', async () => {
    const w = await world360(testDb().db, 'f053-deadlock');
    const first = await questionnaireOf(w, true);
    const second = await w.activity();
    await w.object(second.id, (await w.person('另一评价对象')).id, [first.q.id]);
    const [a, b, c] = await Promise.all([
      enable(w, first.activity.id),
      enable(w, second.id),
      edit(w, first.q.id, editContent(w, 3)),
    ]);
    for (const res of [a, b, c]) expect([200, 400, 409], await res.clone().text()).toContain(res.status);
    expect((await w.getActivity(first.activity.id)).status).toBe(a.status === 200 ? 'enabled' : 'disabled');
    expect((await w.getActivity(second.id)).status).toBe(b.status === 200 ? 'enabled' : 'draft');
    const edited = (await get(w, first.q.id)).questions[0]!.text === EDIT_TEXT;
    expect(edited).toBe(c.status === 200);
    // 编辑成功 ⇒ 它提交时没有活动在启用状态：此后启用的活动，启用校验看到的就是修订后的内容
    if (c.status === 409) expect(await c.json()).toMatchObject({ error: { details: { reason: 'ACTIVITY_ENABLED' } } });
  });
});
