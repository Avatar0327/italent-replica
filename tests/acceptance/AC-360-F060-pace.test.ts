/**
 * AC-360-F060（收尾，DEC-392）：评价过快判定——平均单题耗时 < 1.5 秒算疑似无效 / 提醒。
 * ① 计时：从该评价对象答卷首次打开（POST …/open）到提交，中间离开与空闲都计入；
 * ② 分母：该答卷全部可答题；
 * ③ 多人评价：按份（每个评价者 × 评价对象 × 套卷一份答卷）分别判断；
 * ④ 作答端提醒：点“下一页”按本页判断（POST …/page-check，3 秒自动消失），提交按整份判断，两者都不阻止翻页 / 提交；
 *    同阈值 1.5 秒；
 * ⑤ 一键屏蔽疑似无效：用同一判定，2 小时内只能用一次（原有）；本功能上线前已提交、没有耗时数据的答卷不判耗时（DEC-371③）；
 * ⑥ 页面不显示秒数：任何响应、审计里都没有耗时（DEC-371⑤，只回“是否提醒 / 是否疑似”的布尔）。
 */
import { useTestDb } from '@italent/testkit';
import { sql, withTenant } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { errorOf, key, my, type SceneB, sceneB, sheets } from './AC-360-B-support.js';

const testDb = useTestDb();
const T0 = Date.parse('2026-10-01T02:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const TIMING_KEY = /duration|elapsed|openedAt|pageStartedAt|opened_at|page_started_at|millis/i;

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

/** 一份答卷的完整流程：打开（openAt，undefined = 不调 open）→ 保存 → 在 submitAt 提交；返回提交响应。 */
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
    await s.w.ok(call('POST', `${base}/open`, { body: {} }));
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

describe('AC-360-F060 评价过快：一键屏蔽疑似无效用同一判定（DEC-392①②③⑤）', () => {
  it('耗时按“首次打开 → 提交”，空闲计入；分母 = 全部可答题（3 题）；按份分别判断；无耗时数据的不判', async () => {
    const s = await sceneB(testDb().db, 'f060pace-a');
    const { w, rel, person } = s;
    // 上级：4.499 秒 / 3 题 < 1.5 → 疑似；自评：恰好 4.5 秒 → 不算；同事一：空闲 10 分钟后快速答完 → 不算；
    // 同事二：没有调 open（无耗时数据）→ 不判耗时
    await flow(s, await linkOf(s, person.M.id), rel.superior.id, DIFFERENT, { openAt: 0, submitAt: 4499 });
    await flow(s, await linkOf(s, person.T.id), rel.self.id, DIFFERENT, { openAt: 0, submitAt: 4500 });
    await flow(s, await linkOf(s, person.P1.id), rel.p1.id, DIFFERENT, { openAt: 0, submitAt: 600_000 });
    await flow(s, await linkOf(s, person.P2.id), rel.p2.id, DIFFERENT, { submitAt: 600_100 });
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

  it('同样的耗时，题数多的算过快、题数少的不算：分母是全部可答题（本套卷 3 题，4.4 秒 = 1.47 秒 / 题）', async () => {
    const s = await sceneB(testDb().db, 'f060pace-b');
    await flow(s, await linkOf(s, s.person.P1.id), s.rel.p1.id, DIFFERENT, { openAt: 0, submitAt: 4400 });
    s.w.setNow(at(10_000));
    await s.w.transition(s.activity.id, 'disable');
    expect(
      await s.w.ok(s.w.request('POST', `${s.path}/sheets/block-suspected`, { idempotencyKey: key(), body: {} })),
    ).toEqual({ blocked: 1 });
  });

  it('重复调 open 不会把起点挪到后面：第二次 open 在 1000 秒后，提交在 1003 秒——按第一次打开算，不算过快', async () => {
    const s = await sceneB(testDb().db, 'f060pace-c');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    s.w.setNow(at(0));
    await s.w.ok(call('POST', `${base}/open`, { body: {} }));
    s.w.setNow(at(1_000_000));
    await s.w.ok(call('POST', `${base}/open`, { body: {} }));
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

describe('AC-360-F060 重新作答清掉旧计时（DEC-392①）', () => {
  it('管理员“重新作答”清除答卷的同时清掉计时：再次作答要重新 open，没有 open 的不判耗时；重新 open 后快速提交算过快', async () => {
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
    // 再次作答：没有 open → 无耗时数据，不判（旧计时不能沿用，否则 10 分钟前的起点会让它显得“很慢”）
    const base = taskPath(s, s.rel.p1.id);
    s.w.setNow(at(800_000));
    await s.w.ok(call('POST', `${base}/open`, { body: {} }));
    await flow(s, call, s.rel.p1.id, DIFFERENT, { submitAt: 801_000 });
    s.w.setNow(at(900_000));
    await s.w.transition(s.activity.id, 'disable');
    // 第二次从 800 秒重新 open、1 秒提交 = 0.33 秒 / 题 → 过快（若沿用第一次的起点 0，则 801 秒不算过快）
    expect(
      await s.w.ok(s.w.request('POST', `${s.path}/sheets/block-suspected`, { idempotencyKey: key(), body: {} })),
    ).toEqual({ blocked: 1 });
  });
});

describe('AC-360-F060 作答端提醒（DEC-392④）：按页 / 提交时，都不阻止', () => {
  it('按页：从上一次翻页（或打开）起算，除以本页题数；3 秒自动消失；响应只有布尔与 3 秒，不显示秒数', async () => {
    const s = await sceneB(testDb().db, 'f060pace-e');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    s.w.setNow(at(0));
    await s.w.ok(call('POST', `${base}/open`, { body: {} }));
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
    for (const body of [first]) for (const k of Object.keys(body)) expect(k).not.toMatch(TIMING_KEY);
  });

  it('按页：时间够长但本页连续选择同一选项（≥2 题）也提醒；选项不同不提醒；只有 1 题不判同一选项', async () => {
    const s = await sceneB(testDb().db, 'f060pace-f');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    s.w.setNow(at(0));
    await s.w.ok(call('POST', `${base}/open`, { body: {} }));
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

  it('按页提醒不阻止：提醒之后照常保存、提交', async () => {
    const s = await sceneB(testDb().db, 'f060pace-g');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    s.w.setNow(at(0));
    await s.w.ok(call('POST', `${base}/open`, { body: {} }));
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

  it('提交时按整份判断：过快 → reminder true；够慢且选项不同 → false；够慢但全选同一选项 → true；没有 open（无耗时）且选项不同 → false；都照常提交成功', async () => {
    const s = await sceneB(testDb().db, 'f060pace-h');
    const submit = async (personId: string, relationId: string, picks: readonly string[], openAt?: number) => {
      const res = await flow(s, await linkOf(s, personId), relationId, picks, {
        ...(openAt !== undefined ? { openAt } : {}),
        submitAt: 600_000,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; reminder: boolean };
      expect(body.status).toBe('submitted');
      return body.reminder;
    };
    expect(await submit(s.person.T.id, s.rel.self.id, DIFFERENT, 599_000)).toBe(true); // 1 秒 / 3 题
    expect(await submit(s.person.M.id, s.rel.superior.id, DIFFERENT, 0)).toBe(false); // 10 分钟
    expect(await submit(s.person.P1.id, s.rel.p1.id, ['v4', 'v4', 'v4'], 0)).toBe(true); // 够慢但同一选项
    expect(await submit(s.person.P2.id, s.rel.p2.id, DIFFERENT)).toBe(false); // 没有 open
  });

  it('站内待办入口（/my/todos/:todoId/tasks/…）同样有 open / page-check，且判定一致', async () => {
    const s = await sceneB(testDb().db, 'f060pace-i');
    await s.w.ok(
      s.w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P1.id] } }),
    );
    const todo = my(s.w, s.user.P1);
    const todoId = (await s.w.ok<{ items: { id: string }[] }>(todo('GET', '/todos'))).items[0]!.id;
    const base = `/todos/${todoId}${taskPath(s, s.rel.p1.id)}`;
    s.w.setNow(at(0));
    expect(await s.w.ok(todo('POST', `${base}/open`, { body: {} }))).toEqual({ opened: true });
    s.w.setNow(at(500));
    expect(
      await s.w.ok(todo('POST', `${base}/page-check`, { body: { items: pageItems(s, [0, 1], ['v5', 'v4']) } })),
    ).toEqual({ reminder: true, autoDismissSeconds: 3 });
    // 别人的待办 / 不存在：与作答页同样 404
    const other = my(s.w, s.user.P2);
    expect((await other('POST', `${base}/open`, { body: {} })).status).toBe(404);
    expect((await other('POST', `${base}/page-check`, { body: { items: pageItems(s, [0], ['v5']) } })).status).toBe(
      404,
    );
  });
});

describe('AC-360-F060 open / page-check 的校验与不泄露耗时', () => {
  it('校验：非法题目 / 选项 / 重复题目 / 空列表 400；没有 open 不报错、不提醒；已提交 409；活动暂停 409；别人的令牌与关系 404', async () => {
    const s = await sceneB(testDb().db, 'f060pace-j');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    const check = (body: unknown, c: Call = call, path = base) => c('POST', `${path}/page-check`, { body });
    const bad = '6d8f8f0e-2a4d-4b8b-8d64-5b0c2f7a9e11';
    // 还没有 open：不报错，也不提醒（没有耗时数据）
    s.w.setNow(at(0));
    expect(await s.w.ok(check({ items: pageItems(s, [0, 1], ['v5', 'v4']) }))).toEqual({
      reminder: false,
      autoDismissSeconds: 3,
    });
    await s.w.ok(call('POST', `${base}/open`, { body: {} }));
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
    // 别人的令牌读本人的关系：404（taskGuard）
    const foreign = await linkOf(s, s.person.P2.id);
    await rejected(check({ items: pageItems(s, [0], ['v5']) }, foreign), 404);
    await rejected(foreign('POST', `${base}/open`, { body: {} }), 404);
    // 已提交：409
    await flow(s, call, s.rel.p1.id, DIFFERENT, { submitAt: 5000 });
    await rejected(check({ items: pageItems(s, [0], ['v5']) }), 409, 'SHEET_SUBMITTED');
    await rejected(call('POST', `${base}/open`, { body: {} }), 409, 'SHEET_SUBMITTED');
    // 活动暂停：409
    const other = await linkOf(s, s.person.P2.id);
    await s.w.transition(s.activity.id, 'disable');
    await rejected(other('POST', `${taskPath(s, s.rel.p2.id)}/open`, { body: {} }), 409, 'ACTIVITY_NOT_OPEN');
  });

  it('任何响应与审计里都没有耗时：作答页、open、提交回执、管理端答卷卡片、审计事件', async () => {
    const s = await sceneB(testDb().db, 'f060pace-k');
    const call = await linkOf(s, s.person.P1.id);
    const base = taskPath(s, s.rel.p1.id);
    const texts: string[] = [];
    const record = async (res: Promise<Response>) => texts.push(await (await res).text());
    s.w.setNow(at(0));
    await record(call('GET', base));
    await record(call('POST', `${base}/open`, { body: {} }));
    s.w.setNow(at(300));
    await record(call('POST', `${base}/page-check`, { body: { items: pageItems(s, [0, 1], ['v5', 'v4']) } }));
    const submitted = await flow(s, call, s.rel.p1.id, DIFFERENT, { submitAt: 600 });
    texts.push(await submitted.text());
    await record(call('GET', base));
    s.w.setNow(at(1000));
    await s.w.transition(s.activity.id, 'disable');
    texts.push(JSON.stringify(await sheets(s)));
    for (const text of texts) expect(text).not.toMatch(TIMING_KEY);
    const audited = await withTenant(testDb().db, s.w.tenantId, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM audit_events
        WHERE to_jsonb(audit_events)::text ~* ${TIMING_KEY.source}`),
    );
    const rows = (Array.isArray(audited) ? audited : (audited as { rows: unknown[] }).rows) as { n: number }[];
    expect(rows[0]!.n).toBe(0);
  });
});
