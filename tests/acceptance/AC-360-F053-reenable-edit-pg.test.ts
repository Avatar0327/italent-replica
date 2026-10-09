/**
 * F-053（#107 PR-A3 第 5 轮自检疑点 c，DEC-319③）：编辑“已使用的套卷”与“重新启用活动”并发。
 * 真实 PG 交错：编辑先持锁、启用先持锁、编辑与评价者保存 / 提交在重新启用前后交错，断言计分、作答与审计一致。
 * 不变量（25 §3.1 E3-R2）：套卷被编辑的提交点，不得有任何用到它的活动处于启用状态；启用校验看到的内容就是启用时的内容。
 * 多套卷取锁顺序（启用 × 新增对象 / 替换套卷）见 AC-360-F053-lock-order-pg.test.ts。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { overall, world360 } from './AC-360-support.js';
import {
  auditCount,
  auditOf,
  blockedOrDone,
  edit,
  editAudits,
  editContent,
  EDIT_TEXT,
  enable,
  expectBlocked,
  get,
  pauseAt,
  QUESTIONNAIRE_LOCK,
  questionnaireOf,
  snapshot,
  started,
} from './AC-360-F053-support.js';

const testDb = useTestDb();
afterEach(() => vi.restoreAllMocks());

const reasonOf = async (res: Response) =>
  ((await res.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'AC-360-09 / F-053（DEC-319③）真实 PG：已使用套卷编辑 × 重新启用活动',
  () => {
    it('编辑先持锁（已过“无启用活动”检查、未提交）：重新启用必须等编辑提交；两者先后成功，计分用修订后的权重', async () => {
      const w = await world360(testDb().db, 'f053-edit-first');
      const ctx = await questionnaireOf(w, true);
      const before = await snapshot(w, ctx);
      const editsBefore = await editAudits(w, ctx.q.id);
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
        const after = await snapshot(w, ctx);
        expect(after).toMatchObject({ text: EDIT_TEXT, activity: 'enabled', sheets: 1, submitted: 1, answers: 2 });
        // 旧答卷与答案逐行不变（编辑只改文字 / 权重，选项 ID 稳定）
        expect(after.sheetRows).toEqual(before.sheetRows);
        expect(after.answerRows).toEqual(before.answerRows);
        // 审计：恰好多一条成功的编辑审计，内容是修订后的套卷；启用审计 2 条（首次 + 重新启用）
        expect(await editAudits(w, ctx.q.id)).toEqual({
          total: editsBefore.total + 1,
          revised: editsBefore.revised + 1,
        });
        expect(await auditOf(w, 'survey360.activity.enable', ctx.activity.id)).toHaveLength(2);
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
      const editsBefore = await editAudits(w, ctx.q.id);
      const revision = (await get(w, ctx.q.id)).revision;
      const tokenB = await w.token(ctx.activity.id, ctx.b.id);
      const path = `/tasks/${ctx.relationB.id}/questionnaires/${ctx.q.id}`;
      const gate = pauseAt('survey360.activity.enable');
      const enabling = enable(w, ctx.activity.id);
      let editing: Promise<Response> | undefined;
      try {
        await started(gate.reached, enabling);
        // 启用事务未提交期间：评价者保存仍被拒（活动还是停用），不留答卷
        const answers = ctx.q.questions.map((q) => ({
          itemId: q.id,
          optionId: ctx.q.scales[0]!.options.find((o) => o.key === 'v3')!.id,
        }));
        const early = await w.link(tokenB)('PUT', path, { ifMatch: 0, body: { answers } });
        expect(early.status).toBe(409);
        expect(await reasonOf(early)).toBe('ACTIVITY_NOT_OPEN');
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
        expect(await reasonOf(rejected)).toBe('ACTIVITY_ENABLED');
        expect(await snapshot(w, ctx)).toEqual({ ...before, activity: 'enabled' });
        expect((await get(w, ctx.q.id)).revision).toBe(revision);
        // 审计：被拒的编辑不留成功审计，启用审计多一条
        expect(await editAudits(w, ctx.q.id)).toEqual(editsBefore);
        expect(await auditOf(w, 'survey360.activity.enable', ctx.activity.id)).toHaveLength(2);
        // 活动启用期间评价者乙按原套卷保存并提交；停用后计分仍用原权重
        await w.ok((await w.answer(tokenB, ctx.relationB.id, await get(w, ctx.q.id), ['v3', 'v3'])) as Response);
        await w.transition(ctx.activity.id, 'disable');
        const rows = await w.scores(ctx.activity.id, ctx.object.id);
        expect(overall(rows, 'role', w.role('superior'))).toBeCloseTo(3, 6); // (4 + 2) / 2
      } finally {
        gate.release.resolve();
        await Promise.allSettled([enabling, ...(editing ? [editing] : [])]);
      }
    });

    it('编辑先持锁期间：评价者保存 / 提交被“活动未启用”拒绝且不留答卷与审计；重新启用后保存 / 提交落在修订后的套卷上', async () => {
      const w = await world360(testDb().db, 'f053-rater');
      const ctx = await questionnaireOf(w, true);
      const tokenB = await w.token(ctx.activity.id, ctx.b.id);
      const path = `/tasks/${ctx.relationB.id}/questionnaires/${ctx.q.id}`;
      const answers = ctx.q.questions.map((q) => ({
        itemId: q.id,
        optionId: ctx.q.scales[0]!.options.find((o) => o.key === 'v3')!.id,
      }));
      const saves = await auditCount(w, 'survey360.sheet.save');
      const submits = await auditCount(w, 'survey360.sheet.submit');
      const gate = pauseAt('survey360.questionnaire.update');
      const editing = edit(w, ctx.q.id, editContent(w, 3));
      let enabling: Promise<Response> | undefined;
      try {
        await started(gate.reached, editing);
        enabling = enable(w, ctx.activity.id);
        await expectBlocked(w.db, enabling);
        const early = await w.link(tokenB)('PUT', path, { ifMatch: 0, body: { answers } });
        expect(early.status).toBe(409);
        expect(await reasonOf(early)).toBe('ACTIVITY_NOT_OPEN');
        // 重新启用前的提交请求同样被拒
        const earlySubmit = await w.link(tokenB)('POST', `${path}/submit`, { ifMatch: 0 });
        expect(earlySubmit.status).toBe(409);
        expect(await reasonOf(earlySubmit)).toBe('ACTIVITY_NOT_OPEN');
        expect(await snapshot(w, ctx)).toMatchObject({ sheets: 1, answers: 2, activity: 'disabled' });
        expect(await auditCount(w, 'survey360.sheet.save')).toBe(saves);
        expect(await auditCount(w, 'survey360.sheet.submit')).toBe(submits);
        gate.release.resolve();
        await w.ok(editing);
        await w.ok(enabling);
        const saved = await w.ok<{ revision: number }>(w.link(tokenB)('PUT', path, { ifMatch: 0, body: { answers } }));
        await w.ok(w.link(tokenB)('POST', `${path}/submit`, { ifMatch: saved.revision }));
        const page = await w.ok<{ questionnaire: { items: { text: string }[] } }>(w.link(tokenB)('GET', path));
        expect(page.questionnaire.items.map((i) => i.text)).toContain(EDIT_TEXT);
        expect(await snapshot(w, ctx)).toMatchObject({ sheets: 2, submitted: 2, answers: 4 });
        expect(await auditCount(w, 'survey360.sheet.save')).toBe(saves + 1);
        expect(await auditCount(w, 'survey360.sheet.submit')).toBe(submits + 1);
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
        expect(await reasonOf(rejected)).toBe('ROLE_NOT_IN_QUESTIONNAIRE');
        expect(await snapshot(w, ctx)).toMatchObject({ activity: 'draft', status: 'enabled', sheets: 0 });
        expect((await editAudits(w, ctx.q.id)).revised).toBe(1);
        expect(await auditOf(w, 'survey360.activity.enable', ctx.activity.id)).toHaveLength(0);
      } finally {
        gate.release.resolve();
        await Promise.allSettled([editing, ...(enabling ? [enabling] : [])]);
      }
    });

    // 相邻入口：已启用活动里给评价对象加 / 换用该套卷，与编辑靠套卷行锁 / 外键锁互斥（修复前后都应成立）
    describe.each([
      { entry: '新增评价对象', pauseOn: 'survey360.object.create' },
      { entry: '替换评价对象的套卷', pauseOn: 'survey360.object.questionnaires' },
    ])('相邻入口：$entry × 编辑', ({ entry, pauseOn }) => {
      async function setup(label: string) {
        const w = await world360(testDb().db, label);
        const ctx = await questionnaireOf(w, true); // 套卷已使用、第一个活动已停用
        const other = await w.enableQuestionnaire(await w.keyBehavior());
        const live = await w.activity();
        const liveObject = await w.object(live.id, (await w.person('在线对象')).id, [other.id]);
        await w.transition(live.id, 'enable'); // 另一个活动正在进行，但还没用到 ctx.q
        const newcomer = (await w.person('新增对象')).id;
        const run = () =>
          entry === '新增评价对象'
            ? w.request('POST', `/activities/${live.id}/objects`, {
                ifMatch: 0,
                body: { personId: newcomer, questionnaireIds: [ctx.q.id] },
              })
            : w.request('PUT', `/activities/${live.id}/objects/${liveObject.id}/questionnaires`, {
                ifMatch: liveObject.revision,
                body: { questionnaireIds: [ctx.q.id] },
              });
        return { w, ctx, run };
      }

      it('编辑先持锁：入口等编辑提交，随后用的就是修订后的套卷；之后再编辑一律拒绝', async () => {
        const { w, ctx, run } = await setup('f053-adj-edit-first');
        const gate = pauseAt('survey360.questionnaire.update');
        const editing = edit(w, ctx.q.id, editContent(w, 3));
        let running: Promise<Response> | undefined;
        try {
          await started(gate.reached, editing);
          running = run();
          await expectBlocked(w.db, running, QUESTIONNAIRE_LOCK);
          gate.release.resolve();
          await w.ok(editing);
          expect((await running).status).toBeLessThan(300);
        } finally {
          gate.release.resolve();
          await Promise.allSettled([editing, ...(running ? [running] : [])]);
        }
        expect((await editAudits(w, ctx.q.id)).revised).toBe(1);
        const late = await edit(w, ctx.q.id, editContent(w, 2));
        expect(late.status).toBe(409);
        expect(await reasonOf(late)).toBe('ACTIVITY_ENABLED');
      });

      it('入口先持锁：编辑等入口提交，再被“活动启用中”拒绝，套卷不变、不留成功审计', async () => {
        const { w, ctx, run } = await setup('f053-adj-entry-first');
        const revision = (await get(w, ctx.q.id)).revision;
        const editsBefore = await editAudits(w, ctx.q.id);
        const gate = pauseAt(pauseOn);
        const running = run();
        let editing: Promise<Response> | undefined;
        try {
          await started(gate.reached, running);
          editing = edit(w, ctx.q.id, editContent(w, 3));
          await expectBlocked(w.db, editing);
          gate.release.resolve();
          expect((await running).status).toBeLessThan(300);
          const rejected = await editing;
          expect(rejected.status).toBe(409);
          expect(await reasonOf(rejected)).toBe('ACTIVITY_ENABLED');
        } finally {
          gate.release.resolve();
          await Promise.allSettled([running, ...(editing ? [editing] : [])]);
        }
        expect((await get(w, ctx.q.id)).revision).toBe(revision);
        expect(await editAudits(w, ctx.q.id)).toEqual(editsBefore);
      });
    });

    it('两个活动共用一套卷同时启用并有编辑：不死锁，两次启用都成功，编辑只可能成功或被“活动启用中”拒绝', async () => {
      const w = await world360(testDb().db, 'f053-deadlock');
      const first = await questionnaireOf(w, true);
      const second = await w.activity();
      await w.object(second.id, (await w.person('另一评价对象')).id, [first.q.id]);
      const [a, b, c] = await Promise.all([
        enable(w, first.activity.id),
        enable(w, second.id),
        edit(w, first.q.id, editContent(w, 3)),
      ]);
      // 启用不是冲突方：任何非 200（含被映射成 409 REVISION_CONFLICT 的死锁牺牲者）都不通过
      expect([a.status, b.status], await a.clone().text()).toEqual([200, 200]);
      expect((await w.getActivity(first.activity.id)).status).toBe('enabled');
      expect((await w.getActivity(second.id)).status).toBe('enabled');
      const edited = (await get(w, first.q.id)).questions[0]!.text === EDIT_TEXT;
      expect(edited).toBe(c.status === 200);
      // 编辑成功 ⇒ 它排在两次启用之前；否则必是被启用中的活动拒绝（不是 REVISION_CONFLICT 等其他 409）
      if (c.status !== 200) {
        expect(c.status).toBe(409);
        expect(await reasonOf(c)).toBe('ACTIVITY_ENABLED');
      }
    });
  },
);
