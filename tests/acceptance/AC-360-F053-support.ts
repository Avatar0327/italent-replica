/** F-053 真实 PG 交错测试的共用夹具与屏障（套卷编辑 × 重新启用 × 相邻入口）。 */
import { type Db, sql, withTenant } from '@italent/db';
import { expect, vi } from 'vitest';
import * as context from '../../apps/api/src/modules/survey360/context.js';
import type { QuestionnaireView, World360 } from './AC-360-support.js';

export function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 请求要么在真实数据库锁上等待（返回 'blocked'），要么已经结束（返回响应，说明两条路径没有被串行化）。 */
export async function blockedOrDone(db: Db, pattern: string, request: Promise<Response>) {
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
    if (waiting[0]!.n > 0) return 'blocked' as const;
    await sleep(10);
  }
  throw new Error('请求既未结束也未观测到真实锁等待');
}

/** 套卷表或套卷关联表上的锁等待（FOR UPDATE 或外键 KEY SHARE）。 */
export const QUESTIONNAIRE_LOCK = '%survey360_%questionnaires%';

export async function expectBlocked(db: Db, request: Promise<Response>, pattern = '%survey360_questionnaires%') {
  const outcome = await blockedOrDone(db, pattern, request);
  expect(outcome === 'blocked' ? 'blocked' : `未等待套卷锁，已返回 ${outcome.status}`).toBe('blocked');
}

/** 等到至少 n 个后端处于真实锁等待。 */
export async function waitLockWaiters(db: Db, n: number) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const waiting = context.rows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`),
    );
    if (waiting[0]!.n >= n) return;
    await sleep(10);
  }
  throw new Error(`未观测到 ${n} 个真实锁等待`);
}

/** 命令在 audit360 处暂停：此时业务写入已完成、事务未提交，持有的锁仍在。 */
export function pauseAt(action: string) {
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

export async function started(reached: ReturnType<typeof signal>, request: Promise<Response>) {
  await Promise.race([
    reached.promise,
    request.then((res) => {
      throw new Error('请求未到暂停点：' + res.status);
    }),
  ]);
}

/** 另一个事务持有套卷行锁，直到 release；用来把两个请求卡在确定的锁队列上。 */
export function holdQuestionnaire(w: World360, id: string) {
  const reached = signal();
  const release = signal();
  const promise = withTenant(w.db, w.tenantId, async (tx) => {
    await tx.execute(sql`SELECT id FROM survey360_questionnaires WHERE id = ${id}::uuid FOR UPDATE`);
    reached.resolve();
    await release.promise;
  });
  return { reached, release, promise };
}

export const EDIT_TEXT = '主动沟通（修订）';

/** 他评套卷：上级 / 同事等角色同 AC-360-03；q1 权重改 3 后，上级 v4 + v2 的角色分 3.0 → 3.5。 */
export async function questionnaireOf(w: World360, used: boolean) {
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
export type Fixture = Awaited<ReturnType<typeof questionnaireOf>>;

export const get = (w: World360, id: string) =>
  w.ok<QuestionnaireView & { revision: number }>(w.request('GET', `/questionnaires/${id}`));

export function editContent(w: World360, q1Weight: number, withoutRole?: string) {
  const content = w.keyBehaviorContent({ self: 0, superior: 5, peer: 3, subordinate: 2 });
  return {
    ...content,
    roles: content.roles.filter((r) => r.key !== withoutRole),
    questions: [{ ...content.questions[0]!, text: EDIT_TEXT, weight: q1Weight }, content.questions[1]!],
  };
}

export async function edit(w: World360, id: string, content: ReturnType<typeof editContent>) {
  const current = await get(w, id);
  return w.request('PUT', `/questionnaires/${id}`, { ifMatch: current.revision, body: { content } });
}

export async function enable(w: World360, activityId: string) {
  const current = await w.getActivity(activityId);
  return w.request('POST', `/activities/${activityId}/enable`, { ifMatch: current.revision });
}

/** 套卷、活动状态与该活动全部答卷 / 答案的逐行内容（比对“没被动过”用，不只比计数）。 */
export async function snapshot(w: World360, ctx: Fixture) {
  const q = await get(w, ctx.q.id);
  const activity = await w.getActivity(ctx.activity.id);
  const data = await withTenant(w.db, w.tenantId, async (tx) => {
    const sheets = context.rows<{ id: string; status: string; revision: number }>(
      await tx.execute(sql`SELECT id, status, revision FROM survey360_sheets
        WHERE activity_id = ${ctx.activity.id} ORDER BY id`),
    );
    const answers = context.rows<{ sheet_id: string; item_id: string; option_id: string }>(
      await tx.execute(sql`SELECT an.sheet_id, an.item_id, an.option_id FROM survey360_answers an
        JOIN survey360_sheets s ON s.tenant_id = an.tenant_id AND s.id = an.sheet_id
        WHERE s.activity_id = ${ctx.activity.id} ORDER BY an.sheet_id, an.item_id`),
    );
    const [batches] = context.rows<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM survey360_score_batches
        WHERE activity_id = ${ctx.activity.id}`),
    );
    return { sheets, answers, batches: batches!.n };
  });
  return {
    text: q.questions[0]!.text,
    status: q.status,
    activity: activity.status,
    sheets: data.sheets.length,
    submitted: data.sheets.filter((s) => s.status === 'submitted').length,
    answers: data.answers.length,
    batches: data.batches,
    sheetRows: data.sheets,
    answerRows: data.answers,
  };
}

/** 某对象某动作已提交的审计（before / after 原文）。 */
export async function auditOf(w: World360, action: string, objectId: string) {
  return withTenant(w.db, w.tenantId, async (tx) =>
    context.rows<{ before: unknown; after: unknown }>(
      await tx.execute(sql`SELECT before, after FROM audit_events
        WHERE action = ${action} AND object_id = ${objectId}`),
    ),
  );
}

/** 审计里“套卷首题文字 = 修订后文字”的成功更新次数。 */
export async function editAudits(w: World360, questionnaireId: string) {
  const events = await auditOf(w, 'survey360.questionnaire.update', questionnaireId);
  const texts = events.map((e) => (e.after as { questions: { text: string }[] }).questions[0]!.text);
  return { total: events.length, revised: texts.filter((t) => t === EDIT_TEXT).length };
}

export async function auditCount(w: World360, action: string) {
  const [row] = await withTenant(w.db, w.tenantId, async (tx) =>
    context.rows<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = ${action}`),
    ),
  );
  return row!.n;
}
