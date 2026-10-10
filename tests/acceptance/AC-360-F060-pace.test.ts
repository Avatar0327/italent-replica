/**
 * AC-360-F060（收尾，DEC-392 / DEC-405）：评价过快判定——平均单题耗时 < 1.5 秒算疑似无效 / 提醒。
 * ① 计时：从该评价对象答卷首次打开到提交，中间离开与空闲都计入。“打开”= 取作答页（GET …/questionnaires/:id）时
 *    建立；保存时补建作兜底；没有单独的 open 接口，复刻未上线、没有历史答卷，不取页面直接保存 / 提交的新答卷也纳入判定
 *    （DEC-405②、DEC-402）；
 * ② 分母：该答卷全部可答题；
 * ③ 多人评价：按份（每个评价者 × 评价对象 × 套卷一份答卷）分别判断；
 * ④ 作答端提醒：点“下一页”按本页判断（POST …/page-check，3 秒自动消失），提交按整份判断，两者都不阻止翻页 / 提交；
 *    同阈值 1.5 秒；本页连续选择同一选项的提醒与有没有计时记录无关；
 * ⑤ 一键屏蔽疑似无效：用同一判定，2 小时内只能用一次（原有）；
 * ⑥ 页面不显示秒数：任何响应里都没有耗时，只回“是否提醒 / 是否疑似”的布尔（DEC-371⑤）；
 * ⑦ 计时记录跟着它所属的评价关系 / 评价对象走：重新作答清掉该评价关系的全部计时，替换套卷清掉该评价对象全部评价关系的
 *    计时——无论答卷是否已保存（第 1 轮审查 P2-1）；
 * ⑧ 计时写入要写审计（DEC-405①，DEC-019）：首次建立、翻页更新、清除（保留快照）；审计查看不披露计时（对象类型不登记）。
 */
import { useTestDb } from '@italent/testkit';
import { sql, withTenant } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { auditObjectRegistered } from '../../apps/api/src/audit/visibility.js';
import { rows } from '../../apps/api/src/modules/survey360/context.js';
import { auditApi } from './AC-AUD-support.js';
import { world360, type World360 } from './AC-360-support.js';
import { errorOf, key, my, type SceneB, sceneB, sheets } from './AC-360-B-support.js';

const testDb = useTestDb();
const T0 = Date.parse('2026-10-01T02:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const TIMING_KEY = /duration|elapsed|openedAt|pageStartedAt|opened_at|page_started_at|millis/i;
const TIMING_TYPE = 'survey360-sheet-timing';

const taskPath = (s: SceneB, relationId: string) => `/tasks/${relationId}/questionnaires/${s.q.id}`;
const optionOf = (s: SceneB, optionKey: string) => s.q.scales[0]!.options.find((o) => o.key === optionKey)!.id;
const answersOf = (s: SceneB, picks: readonly string[]) =>
  s.q.questions.map((question, index) => ({ itemId: question.id, optionId: optionOf(s, picks[index]!) }));
const pageItems = (s: SceneB, indexes: readonly number[], picks: readonly (string | null)[]) =>
  indexes.map((index, n) => ({
    itemId: s.q.questions[index]!.id,
    ...(picks[n] ? { optionId: optionOf(s, picks[n]!) } : {}),
  }));

type Call = ReturnType<SceneB['w']['link']>;

/** 一份答卷的完整流程：取作答页（openAt，undefined = 不取页面）→ 保存 → 在 submitAt 提交；返回提交响应。 */
async function flow(
  s: SceneB,
  call: Call,
  relationId: string,
  picks: readonly string[],
  times: { openAt?: number; submitAt: number },
) {
  const base = taskPath(s, relationId);
  if (times.openAt !== undefined) {
    s.w.setNow(at(times.openAt));
    await s.w.ok(call('GET', base));
  }
  s.w.setNow(at(times.submitAt - 1));
  const saved = await s.w.ok<{ revision: number }>(
    call('PUT', `${base}`, { ifMatch: 0, body: { answers: answersOf(s, picks) } }),
  );
  s.w.setNow(at(times.submitAt));
  return call('POST', `${base}/submit`, { ifMatch: saved.revision });
}

const linkOf = async (s: SceneB, personId: string) => s.w.link(await s.w.token(s.activity.id, personId));
const DIFFERENT = ['v5', 'v4', 'v3'] as const;

interface TimingRow {
  relation_id: string;
  questionnaire_id: string;
  opened_at: string;
  page_started_at: string;
}
const timings = async (w: World360, filter = sql`true`) =>
  rows<TimingRow>(
    await withTenant(testDb().db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT relation_id, questionnaire_id, opened_at, page_started_at
        FROM survey360_sheet_timings WHERE ${filter} ORDER BY relation_id, questionnaire_id`),
    ),
  );
const dropTimings = (w: World360) =>
  withTenant(testDb().db, w.tenantId, (tx) => tx.execute(sql`DELETE FROM survey360_sheet_timings`));

interface TimingAudit {
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}
const timingAudit = async (w: World360) =>
  rows<TimingAudit>(
    await withTenant(testDb().db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT action, before, after FROM audit_events
        WHERE object_type = ${TIMING_TYPE} ORDER BY occurred_at, id`),
    ),
  );

describe('AC-360-F060 评价过快：一键屏蔽疑似无效用同一判定（DEC-392①②③⑤）', () => {
  it('耗时按“首次打开 → 提交”，空闲计入；分母 = 全部可答题（3 题）；按份分别判断', async () => {
    const s = await sceneB(testDb().db, 'f060pace-a');
    const { w, rel, person } = s;
    // 上级：4.499 秒 / 3 题 < 1.5 → 疑似；自评：恰好 4.5 秒 → 不算；同事一：空闲 10 分钟后快速答完 → 不算；
    // 同事二：慢速作答 → 不算
    await flow(s, await linkOf(s, person.M.id), rel.superior.id, DIFFERENT, { openAt: 0, submitAt: 4499 });
    await flow(s, await linkOf(s, person.T.id), rel.self.id, DIFFERENT, { openAt: 0, submitAt: 4500 });
    await flow(s, await linkOf(s, person.P1.id), rel.p1.id, DIFFERENT, { openAt: 0, submitAt: 600_000 });
    await flow(s, await linkOf(s, person.P2.id), rel.p2.id, DIFFERENT, { openAt: 0, submitAt: 600_100 });
    w.setNow(at(700_000));
    await w.transition(s.activity.id, 'disable');
    const result = await w.ok<{ blocked: number }>(
      w.request('POST', `${s.path}/sheets/block-suspected`, { idempotencyKey: key(), body: {} }),
    );
    expect(result).toEqual({ blocked: 1 });
    const cards = await sheets(s);
    expect(cards).toHaveLength(4);
    const blocked = cards.filter((c) => c.blocked);
    expect(blocked.map((c) => [c.role.name, c.blockSource])).toEqual([['上级', 'suspected']]);
  });

  it('不取作答页、直接保存 / 提交的新答卷也纳入判定：从第一次保存起算（DEC-405②，取消历史答卷豁免）', async () => {
    const s = await sceneB(testDb().db, 'f060pace-n');
    // 没有 GET：第一次保存在提交前 1 毫秒 → 疑似；对照：先取页面（0）再慢速保存提交 → 不算
    await flow(s, await linkOf(s, s.person.P1.id), s.rel.p1.id, DIFFERENT, { submitAt: 600_100 });
    await flow(s, await linkOf(s, s.person.P2.id), s.rel.p2.id, DIFFERENT, { openAt: 0, submitAt: 600_100 });
    s.w.setNow(at(700_000));
    await s.w.transition(s.activity.id, 'disable');
    expect(
      await s.w.ok(s.w.request('POST', `${s.path}/sheets/block-suspected`, { idempotencyKey: key(), body: {} })),
    ).toEqual({ blocked: 1 });
    expect((await sheets(s)).filter((c) => c.blocked).map((c) => c.role.name)).toEqual(['同事']);
  });

  it('同样的耗时，题数多的算过快、题数少的不算：分母是全部可答题（本套卷 3 题，4.4 秒 = 1.47 秒 / 题）', async () => {
    const s = await sceneB(testDb().db, 'f060pace-b');
    await flow(s, await linkOf(s, s.person.P1.id), s.rel.p1.id, DIFFERENT, { openAt: 0, submitAt: 4400 });
    s.w.setNow(at(10_000));
    await s.w.transition(s.activity.id, 'disable');
    expect(
      await s.w.ok(s.w.request('POST', `${s.path}/sheets/block-suspected`, { idempotencyKey: key(), body: {} })),
    ).toEqual({ blocked: 1 });
  });

  it('重复取作答页不会把起点挪到后面：第二次取页在 1000 秒后，提交在 1003 秒——按第一次打开算，不算过快', async () => {
    const s = await sceneB(testDb().db, 'f060pace-c');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    s.w.setNow(at(0));
    await s.w.ok(call('GET', base));
    s.w.setNow(at(1_000_000));
    await s.w.ok(call('GET', base));
    await flow(s, call, s.rel.p1.id, DIFFERENT, { submitAt: 1_003_000 });
    s.w.setNow(at(1_100_000));
    await s.w.transition(s.activity.id, 'disable');
    expect(
      await s.w.ok(s.w.request('POST', `${s.path}/sheets/block-suspected`, { idempotencyKey: key(), body: {} })),
    ).toEqual({ blocked: 0 });
  });

  it('一键屏蔽 2 小时内仍只能用一次（原有口径不变）', async () => {
    const s = await sceneB(testDb().db, 'f060pace-d');
    await flow(s, await linkOf(s, s.person.P1.id), s.rel.p1.id, DIFFERENT, { openAt: 0, submitAt: 1000 });
    s.w.setNow(at(5000));
    await s.w.transition(s.activity.id, 'disable');
    const run = () => s.w.request('POST', `${s.path}/sheets/block-suspected`, { idempotencyKey: key(), body: {} });
    expect(await s.w.ok(run())).toEqual({ blocked: 1 });
    const again = await run();
    expect(again.status).toBe(409);
    expect((await errorOf(again)).details?.reason).toBe('RATE_LIMITED');
  });
});

describe('AC-360-F060 计时跟着评价关系 / 评价对象清除（DEC-392①，第 1 轮审查 P2-1）', () => {
  it('管理员“重新作答”清掉该评价关系的计时：再次作答从重新取页起算；快照与清除审计保留', async () => {
    const s = await sceneB(testDb().db, 'f060pace-r');
    const call = await linkOf(s, s.person.P1.id);
    // 第一次：慢速作答，不算过快
    await flow(s, call, s.rel.p1.id, DIFFERENT, { openAt: 0, submitAt: 600_000 });
    s.w.setNow(at(700_000));
    const row = (
      await s.w.ok<{ items: { relationId: string; revision: number }[] }>(
        s.w.as(s.w.admin)('GET', `${s.path}/progress/${s.person.P1.id}`),
      )
    ).items[0]!;
    await s.w.ok(s.w.request('POST', `${s.path}/relations/${row.relationId}/reanswer`, { ifMatch: row.revision }));
    expect(await timings(s.w)).toEqual([]);
    const cleared = (await timingAudit(s.w)).filter((e) => e.action === 'survey360.sheet-timing.clear');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.before).toMatchObject({ relationId: s.rel.p1.id, questionnaireId: s.q.id });
    expect(cleared[0]!.before).toHaveProperty('openedAt');
    // 再次作答：800 秒取页、801 秒提交 = 0.33 秒 / 题 → 过快（若沿用第一次的起点 0，则 801 秒不算过快）
    await flow(s, call, s.rel.p1.id, DIFFERENT, { openAt: 800_000, submitAt: 801_000 });
    s.w.setNow(at(900_000));
    await s.w.transition(s.activity.id, 'disable');
    expect(
      await s.w.ok(s.w.request('POST', `${s.path}/sheets/block-suspected`, { idempotencyKey: key(), body: {} })),
    ).toEqual({ blocked: 1 });
  });

  /** 一个活动、一个评价对象带 [A, B] 两套卷、一个评价者；再备一套 C 供替换。 */
  async function replaceScene(label: string) {
    const w = await world360(testDb().db, label);
    const a = await w.enableQuestionnaire(await w.keyBehavior());
    const b = await w.enableQuestionnaire(await w.keyBehavior());
    const c = await w.enableQuestionnaire(await w.keyBehavior());
    const activity = await w.activity();
    const object = await w.object(activity.id, (await w.person('替换对象')).id, [a.id, b.id]);
    const rater = await w.person('评价者');
    const relation = await w.appraiser(activity.id, object.id, rater.id, 'superior');
    await w.transition(activity.id, 'enable');
    const call = w.link(await w.token(activity.id, rater.id));
    const page = (q: { id: string }) => `/tasks/${relation.id}/questionnaires/${q.id}`;
    const replace = (questionnaireIds: string[], revision: number, confirmClearAnswers?: boolean) =>
      w.request('PUT', `/activities/${activity.id}/objects/${object.id}/questionnaires`, {
        ifMatch: revision,
        body: { questionnaireIds, ...(confirmClearAnswers ? { confirmClearAnswers } : {}) },
      });
    return { w, a, b, c, activity, object, relation, rater, call, page, replace };
  }

  it('替换套卷：只打开过、一份都没保存（没有答卷）时，也清掉该评价对象的计时；换回后从重新取页起算', async () => {
    const r = await replaceScene('f060pace-p1');
    r.w.setNow(at(0));
    await r.w.ok(r.call('GET', r.page(r.a)));
    expect(await timings(r.w)).toHaveLength(1);
    // 没有答卷，不需要确认
    r.w.setNow(at(600_000));
    const replaced = await r.w.ok<{ revision: number }>(r.replace([r.c.id], r.object.revision));
    expect(await timings(r.w)).toEqual([]);
    const cleared = (await timingAudit(r.w)).filter((e) => e.action === 'survey360.sheet-timing.clear');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.before).toMatchObject({ relationId: r.relation.id, questionnaireId: r.a.id });
    // 换回 A 后重新取页：起点是新的一次，不是 600 秒前的旧起点
    r.w.setNow(at(1_200_000));
    await r.w.ok(r.replace([r.a.id], replaced.revision));
    r.w.setNow(at(1_800_000));
    await r.w.ok(r.call('GET', r.page(r.a)));
    const [row] = await timings(r.w);
    expect(new Date(row!.opened_at).toISOString()).toBe(at(1_800_000));
  });

  it('替换套卷：对象有两套卷，A 已保存草稿、B 只打开过——两份计时都清掉（部分保存）', async () => {
    const r = await replaceScene('f060pace-p2');
    r.w.setNow(at(0));
    await r.w.ok(r.call('GET', r.page(r.a)));
    await r.w.ok(
      r.call('PUT', r.page(r.a), {
        ifMatch: 0,
        body: { answers: r.a.questions.map((q) => ({ itemId: q.id, optionId: r.a.scales[0]!.options[0]!.id })) },
      }),
    );
    await r.w.ok(r.call('GET', r.page(r.b)));
    expect(await timings(r.w)).toHaveLength(2);
    r.w.setNow(at(600_000));
    // 有草稿答卷：要确认
    const refused = await r.replace([r.b.id, r.c.id], r.object.revision);
    expect(refused.status).toBe(409);
    expect(await timings(r.w)).toHaveLength(2);
    const replaced = await r.w.ok<{ revision: number }>(r.replace([r.b.id, r.c.id], r.object.revision, true));
    expect(replaced.revision).toBeGreaterThan(r.object.revision);
    expect(await timings(r.w)).toEqual([]);
    // 两份各留快照
    const cleared = (await timingAudit(r.w)).filter((e) => e.action === 'survey360.sheet-timing.clear');
    expect(cleared.map((e) => e.before?.questionnaireId).sort()).toEqual([r.a.id, r.b.id].sort());
    // 重新取页 B：起点是新的一次
    r.w.setNow(at(1_200_000));
    await r.w.ok(r.call('GET', r.page(r.b)));
    const [row] = await timings(r.w);
    expect(new Date(row!.opened_at).toISOString()).toBe(at(1_200_000));
  });

  it('替换套卷不碰其他评价对象的计时', async () => {
    const r = await replaceScene('f060pace-p3');
    const other = await r.w.object(r.activity.id, (await r.w.person('另一对象')).id, [r.a.id]);
    const otherRater = await r.w.person('另一评价者');
    const otherRelation = await r.w.appraiser(r.activity.id, other.id, otherRater.id, 'superior');
    r.w.setNow(at(0));
    await r.w.ok(r.call('GET', r.page(r.a)));
    const otherCall = r.w.link(await r.w.token(r.activity.id, otherRater.id));
    await r.w.ok(otherCall('GET', `/tasks/${otherRelation.id}/questionnaires/${r.a.id}`));
    expect(await timings(r.w)).toHaveLength(2);
    await r.w.ok(r.replace([r.c.id], r.object.revision));
    expect((await timings(r.w)).map((t) => t.relation_id)).toEqual([otherRelation.id]);
  });
});

describe('AC-360-F060 作答端提醒（DEC-392④）：按页 / 提交时，都不阻止', () => {
  it('按页：从上一次翻页（或打开）起算，除以本页题数；3 秒自动消失；响应只有布尔与 3 秒，不显示秒数', async () => {
    const s = await sceneB(testDb().db, 'f060pace-e');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    s.w.setNow(at(0));
    await s.w.ok(call('GET', base));
    const check = async (ms: number, items: ReturnType<typeof pageItems>) => {
      s.w.setNow(at(ms));
      return s.w.ok<Record<string, unknown>>(call('POST', `${base}/page-check`, { body: { items } }));
    };
    // 第 1 页（2 题）：2 秒 → 1 秒 / 题 < 1.5 → 提醒
    const first = await check(2000, pageItems(s, [0, 1], ['v5', 'v4']));
    expect(first).toEqual({ reminder: true, autoDismissSeconds: 3 });
    // 第 2 页（1 题）：距上次翻页 30 秒 → 不提醒；起点已挪到上次翻页
    expect(await check(32_000, pageItems(s, [2], ['v3']))).toEqual({ reminder: false, autoDismissSeconds: 3 });
    // 再翻一页只隔 0.5 秒：按“上次翻页”算 → 提醒（证明起点跟着翻页走，不是一直从打开起算）
    expect(await check(32_500, pageItems(s, [2], ['v3']))).toEqual({ reminder: true, autoDismissSeconds: 3 });
    for (const k of Object.keys(first)) expect(k).not.toMatch(TIMING_KEY);
  });

  it('按页：时间够长但本页连续选择同一选项（≥2 题）也提醒；选项不同不提醒；只有 1 题不判同一选项', async () => {
    const s = await sceneB(testDb().db, 'f060pace-f');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    s.w.setNow(at(0));
    await s.w.ok(call('GET', base));
    const check = async (ms: number, items: ReturnType<typeof pageItems>) => {
      s.w.setNow(at(ms));
      return (await s.w.ok<{ reminder: boolean }>(call('POST', `${base}/page-check`, { body: { items } }))).reminder;
    };
    expect(await check(60_000, pageItems(s, [0, 1], ['v4', 'v4']))).toBe(true);
    expect(await check(120_000, pageItems(s, [0, 1], ['v4', 'v3']))).toBe(false);
    expect(await check(180_000, pageItems(s, [0], ['v4']))).toBe(false);
    // 有未选的题时，只比较已选的：一题已选一题未选，不够两个已选，不判
    expect(await check(240_000, pageItems(s, [0, 1], ['v4', null]))).toBe(false);
  });

  it('同一选项的提醒与有没有计时记录无关（第 1 轮审查 P2-2）：删掉计时后同选项仍提醒、不同选项不提醒；链接与待办入口一致', async () => {
    const s = await sceneB(testDb().db, 'f060pace-s');
    await s.w.ok(
      s.w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P1.id] } }),
    );
    const call = await linkOf(s, s.person.P1.id);
    const todo = my(s.w, s.user.P1);
    const todoId = (await s.w.ok<{ items: { id: string }[] }>(todo('GET', '/todos'))).items[0]!.id;
    const entries = [
      { name: '链接', send: call as Call, base: taskPath(s, s.rel.p1.id) },
      { name: '待办', send: todo as Call, base: `/todos/${todoId}${taskPath(s, s.rel.p1.id)}` },
    ];
    for (const { name, send, base } of entries) {
      for (const [picks, expected] of [
        [['v4', 'v4'], true],
        [['v4', 'v3'], false],
      ] as const) {
        await dropTimings(s.w);
        s.w.setNow(at(60_000));
        const res = await s.w.ok<{ reminder: boolean }>(
          send('POST', `${base}/page-check`, { body: { items: pageItems(s, [0, 1], picks) } }),
        );
        expect(res.reminder, `${name} ${picks.join()}`).toBe(expected);
      }
    }
  });

  it('按页提醒不阻止：提醒之后照常保存、提交', async () => {
    const s = await sceneB(testDb().db, 'f060pace-g');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    s.w.setNow(at(0));
    await s.w.ok(call('GET', base));
    s.w.setNow(at(100));
    expect(
      (
        await s.w.ok<{ reminder: boolean }>(
          call('POST', `${base}/page-check`, { body: { items: pageItems(s, [0, 1, 2], ['v4', 'v4', 'v4']) } }),
        )
      ).reminder,
    ).toBe(true);
    const done = await flow(s, call, s.rel.p1.id, ['v4', 'v4', 'v4'], { submitAt: 200 });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { status: string }).status).toBe('submitted');
  });

  it('提交时按整份判断：过快 → reminder true；够慢且选项不同 → false；够慢但全选同一选项 → true；都照常提交成功', async () => {
    const s = await sceneB(testDb().db, 'f060pace-h');
    const submit = async (personId: string, relationId: string, picks: readonly string[], openAt: number) => {
      const res = await flow(s, await linkOf(s, personId), relationId, picks, { openAt, submitAt: 600_000 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; reminder: boolean };
      expect(body.status).toBe('submitted');
      return body.reminder;
    };
    expect(await submit(s.person.T.id, s.rel.self.id, DIFFERENT, 599_000)).toBe(true); // 1 秒 / 3 题
    expect(await submit(s.person.M.id, s.rel.superior.id, DIFFERENT, 0)).toBe(false); // 10 分钟
    expect(await submit(s.person.P1.id, s.rel.p1.id, ['v4', 'v4', 'v4'], 0)).toBe(true); // 够慢但同一选项
  });

  it('不取页面、直接保存提交的新答卷：提交提醒也按第一次保存起算', async () => {
    const s = await sceneB(testDb().db, 'f060pace-q');
    const res = await flow(s, await linkOf(s, s.person.P2.id), s.rel.p2.id, DIFFERENT, { submitAt: 600_000 });
    expect(((await res.json()) as { reminder: boolean }).reminder).toBe(true);
  });

  it('站内待办入口（/my/todos/:todoId/tasks/…）：取页建立计时，page-check 判定一致；没有 open 接口', async () => {
    const s = await sceneB(testDb().db, 'f060pace-i');
    await s.w.ok(
      s.w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P1.id] } }),
    );
    const todo = my(s.w, s.user.P1);
    const todoId = (await s.w.ok<{ items: { id: string }[] }>(todo('GET', '/todos'))).items[0]!.id;
    const base = `/todos/${todoId}${taskPath(s, s.rel.p1.id)}`;
    s.w.setNow(at(0));
    await s.w.ok(todo('GET', base));
    expect(await timings(s.w)).toHaveLength(1);
    s.w.setNow(at(500));
    expect(
      await s.w.ok(todo('POST', `${base}/page-check`, { body: { items: pageItems(s, [0, 1], ['v5', 'v4']) } })),
    ).toEqual({ reminder: true, autoDismissSeconds: 3 });
    // 别人的待办 / 不存在：与作答页同样 404
    const other = my(s.w, s.user.P2);
    expect((await other('GET', base)).status).toBe(404);
    expect((await other('POST', `${base}/page-check`, { body: { items: pageItems(s, [0], ['v5']) } })).status).toBe(
      404,
    );
    // open 接口已移除（取页即建立计时）
    expect([404, 405]).toContain((await todo('POST', `${base}/open`, { body: {} })).status);
    const link = await linkOf(s, s.person.P1.id);
    expect([404, 405]).toContain((await link('POST', `${taskPath(s, s.rel.p1.id)}/open`, { body: {} })).status);
  });
});

describe('AC-360-F060 计时写入的审计（DEC-405①）与取页建立计时', () => {
  it('取作答页建立计时（只一行、只一条审计）；保存不新增；翻页每次一条更新审计；提交不改计时', async () => {
    const s = await sceneB(testDb().db, 'f060pace-u');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    s.w.setNow(at(0));
    expect((await call('GET', base)).status).toBe(200);
    s.w.setNow(at(5_000));
    expect((await call('GET', base)).status).toBe(200);
    const [row] = await timings(s.w);
    expect(await timings(s.w)).toHaveLength(1);
    expect(new Date(row!.opened_at).toISOString()).toBe(at(0));
    expect(new Date(row!.page_started_at).toISOString()).toBe(at(0));
    let events = await timingAudit(s.w);
    expect(events.map((e) => e.action)).toEqual(['survey360.sheet-timing.open']);
    expect(events[0]!.before).toBeNull();
    expect(events[0]!.after).toMatchObject({
      activityId: s.activity.id,
      relationId: s.rel.p1.id,
      questionnaireId: s.q.id,
    });
    // 翻页两次：两条更新审计，前后值各自带翻页起点；打开时刻不动
    for (const ms of [10_000, 20_000]) {
      s.w.setNow(at(ms));
      await s.w.ok(call('POST', `${base}/page-check`, { body: { items: pageItems(s, [0], ['v5']) } }));
    }
    events = await timingAudit(s.w);
    expect(events.map((e) => e.action)).toEqual([
      'survey360.sheet-timing.open',
      'survey360.sheet-timing.page',
      'survey360.sheet-timing.page',
    ]);
    expect(events[2]!.before).toMatchObject({ pageStartedAt: at(10_000), openedAt: at(0) });
    expect(events[2]!.after).toMatchObject({ pageStartedAt: at(20_000), openedAt: at(0) });
    // 保存与提交都不新增计时审计
    const res = await flow(s, call, s.rel.p1.id, DIFFERENT, { submitAt: 30_000 });
    expect(res.status).toBe(200);
    expect(await timingAudit(s.w)).toHaveLength(3);
  });

  it('不取页面、直接保存时补建计时并留审计（兜底）', async () => {
    const s = await sceneB(testDb().db, 'f060pace-v');
    const call = await linkOf(s, s.person.P1.id);
    s.w.setNow(at(0));
    await s.w.ok(call('PUT', taskPath(s, s.rel.p1.id), { ifMatch: 0, body: { answers: answersOf(s, DIFFERENT) } }));
    expect(await timings(s.w)).toHaveLength(1);
    expect((await timingAudit(s.w)).map((e) => e.action)).toEqual(['survey360.sheet-timing.open']);
  });

  it('待办入口取页建立计时同样留审计', async () => {
    const s = await sceneB(testDb().db, 'f060pace-w');
    await s.w.ok(
      s.w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P1.id] } }),
    );
    const todo = my(s.w, s.user.P1);
    const todoId = (await s.w.ok<{ items: { id: string }[] }>(todo('GET', '/todos'))).items[0]!.id;
    await s.w.ok(todo('GET', `/todos/${todoId}${taskPath(s, s.rel.p1.id)}`));
    expect((await timingAudit(s.w)).map((e) => e.action)).toEqual(['survey360.sheet-timing.open']);
  });

  it('活动暂停 / 答卷已提交时取页不建立计时（也不报错）', async () => {
    const s = await sceneB(testDb().db, 'f060pace-x');
    const call = await linkOf(s, s.person.P1.id);
    await flow(s, call, s.rel.p1.id, DIFFERENT, { openAt: 0, submitAt: 5000 });
    await dropTimings(s.w);
    const audited = (await timingAudit(s.w)).length;
    await s.w.ok(call('GET', taskPath(s, s.rel.p1.id))); // 已提交：只读，不建
    await s.w.transition(s.activity.id, 'disable');
    await s.w.ok((await linkOf(s, s.person.P2.id))('GET', taskPath(s, s.rel.p2.id))); // 暂停：只读，不建
    expect(await timings(s.w)).toEqual([]);
    expect(await timingAudit(s.w)).toHaveLength(audited);
  });
});

describe('AC-360-F060 校验、不泄露耗时、审计不披露', () => {
  it('校验：非法题目 / 选项 / 重复题目 / 空列表 400；已提交 409；活动暂停 409；别人的令牌与关系 404', async () => {
    const s = await sceneB(testDb().db, 'f060pace-j');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    const check = (body: unknown, c: Call = call, path = base) => c('POST', `${path}/page-check`, { body });
    const bad = '6d8f8f0e-2a4d-4b8b-8d64-5b0c2f7a9e11';
    s.w.setNow(at(0));
    await s.w.ok(call('GET', base));
    const rejected = async (res: Promise<Response>, status: number, reason?: string) => {
      const r = await res;
      expect(r.status).toBe(status);
      if (reason) expect((await errorOf(r)).details?.reason).toBe(reason);
    };
    await rejected(check({ items: [] }), 400);
    await rejected(check({}), 400);
    await rejected(check({ items: [{ itemId: bad, optionId: optionOf(s, 'v5') }] }), 400, 'ITEM_NOT_ALLOWED');
    await rejected(check({ items: [{ itemId: s.q.questions[0]!.id, optionId: bad }] }), 400, 'OPTION_NOT_ALLOWED');
    const dup = [pageItems(s, [0], ['v5'])[0]!, pageItems(s, [0], ['v4'])[0]!];
    await rejected(check({ items: dup }), 400, 'DUPLICATE_ITEM');
    await rejected(check({ items: pageItems(s, [0], ['v5']), extra: 1 }), 400);
    // 别人的令牌读本人的关系：404，而且别人取页不建立计时
    const foreign = await linkOf(s, s.person.P2.id);
    await rejected(check({ items: pageItems(s, [0], ['v5']) }, foreign), 404);
    await rejected(foreign('GET', base), 404);
    expect(await timings(s.w)).toHaveLength(1);
    // 已提交：409
    await flow(s, call, s.rel.p1.id, DIFFERENT, { submitAt: 5000 });
    await rejected(check({ items: pageItems(s, [0], ['v5']) }), 409, 'SHEET_SUBMITTED');
    // 活动暂停：409
    const other = await linkOf(s, s.person.P2.id);
    await s.w.transition(s.activity.id, 'disable');
    await rejected(
      check({ items: pageItems(s, [0], ['v5']) }, other, taskPath(s, s.rel.p2.id)),
      409,
      'ACTIVITY_NOT_OPEN',
    );
  });

  it('任何响应里都没有耗时（先断言状态码与响应形状）；审计查看里没有计时对象，对象类型不登记', async () => {
    const s = await sceneB(testDb().db, 'f060pace-k');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    const texts: string[] = [];
    s.w.setNow(at(0));
    const page = await call('GET', base);
    expect(page.status).toBe(200);
    const pageBody = (await page.clone().json()) as Record<string, unknown>;
    expect(Object.keys(pageBody)).toEqual(expect.arrayContaining(['activity', 'object', 'questionnaire', 'sheet']));
    texts.push(await page.text());
    s.w.setNow(at(300));
    const turned = await call('POST', `${base}/page-check`, { body: { items: pageItems(s, [0, 1], ['v5', 'v4']) } });
    expect(turned.status).toBe(200);
    const turnedBody = (await turned.clone().json()) as Record<string, unknown>;
    expect(Object.keys(turnedBody).sort()).toEqual(['autoDismissSeconds', 'reminder']);
    expect(typeof turnedBody.reminder).toBe('boolean');
    texts.push(await turned.text());
    const submitted = await flow(s, call, s.rel.p1.id, DIFFERENT, { submitAt: 600 });
    expect(submitted.status).toBe(200);
    const submittedBody = (await submitted.clone().json()) as Record<string, unknown>;
    expect(submittedBody).toMatchObject({ status: 'submitted' });
    expect(typeof submittedBody.reminder).toBe('boolean');
    texts.push(await submitted.text());
    const again = await call('GET', base);
    expect(again.status).toBe(200);
    texts.push(await again.text());
    s.w.setNow(at(1000));
    await s.w.transition(s.activity.id, 'disable');
    const cards = await sheets(s);
    expect(cards).toHaveLength(1);
    texts.push(JSON.stringify(cards));
    for (const text of texts) expect(text).not.toMatch(TIMING_KEY);

    // 审计已落库，但审计查看不披露：没有计时对象，整份返回里也没有计时 / 时间元数据字段
    expect((await timingAudit(s.w)).length).toBeGreaterThan(0);
    expect(auditObjectRegistered(TIMING_TYPE)).toBe(false);
    const audit = auditApi(testDb().db, at(2000), { authorize: s.w.authorize });
    const as = { user: s.w.admin, tenant: s.w.tenantId };
    const listed = await audit.dataChanges(as, { limit: '100' });
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.items.some((i) => i.objectType === TIMING_TYPE)).toBe(false);
    expect(JSON.stringify(listed)).not.toMatch(TIMING_KEY);
    const typed = await audit.dataChanges(as, { objectType: TIMING_TYPE });
    expect(typed.items).toEqual([]);
  });
});
