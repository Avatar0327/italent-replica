/**
 * R3-T03 PR-B「查看人 × 接口 × 字段」可见性矩阵（派发单 §37；DEC-149 两个匿名开关各取两态）：
 * - 开关 A（活动级：作答页评价者姓名、评价角色）只影响作答页（链接与待办同一页面）的两个键；
 *   开关 B（报告模板：文本答案中是否呈现评价角色）只影响报告文本答案的角色键；
 *   其余接口（原始数据、结果报表、进程控制、报告其余部分）在四种组合下完全相同；
 * - 受限管理员（精细化开启）：进程控制、原始数据、报告、报表只含范围内的评价对象 / 评价者，范围外 404；
 * - 审计：答卷类日志（保存、提交、屏蔽、清除）给有活动授权的管理员看脱敏版本（DEC-340③，详见 AC-360-B-08）；
 *   没有活动授权的一般管理员看不到。
 */
import { randomUUID } from 'node:crypto';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import type { PersonView } from './AC-360-support.js';
import {
  errorOf,
  hire,
  key,
  my,
  progress,
  progressDetail,
  reports,
  sceneB,
  type SceneB,
  sheets,
  type TodoView,
} from './AC-360-B-support.js';

const testDb = useTestDb();

async function answered(label: string) {
  const s = await sceneB(testDb().db, label);
  await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4'], { suggestion: '自评：继续保持' });
  await s.answerAs(s.person.M.id, s.rel.superior.id, ['v3', 'v4', 'v5'], { suggestion: '上级：加强授权' });
  await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v3', 'v4'], { suggestion: '同事：多分享' });
  return s;
}

async function setA(s: SceneB, on: boolean) {
  const current = await s.w.getActivity(s.activity.id);
  await s.w.ok(
    s.w.request('PUT', s.path, {
      ifMatch: current.revision,
      body: { showAppraiserName: on, roleDisplay: on ? 'name' : 'hidden' },
    }),
  );
}

async function setB(s: SceneB, on: boolean) {
  const t = await s.w.ok<{ revision: number }>(s.w.request('GET', '/report-template'));
  await s.w.ok(s.w.request('PUT', '/report-template', { ifMatch: t.revision, body: { showTextRole: on } }));
}

/** 与开关无关的接口快照。 */
async function invariant(s: SceneB) {
  return JSON.stringify({
    sheets: await sheets(s),
    total: await s.w.ok(s.w.request('GET', `${s.path}/score-tables?level=questionnaire`)),
    question: await s.w.ok(s.w.request('GET', `${s.path}/score-tables?level=question`)),
    progress: await progress(s),
    detail: await progressDetail(s, s.person.P1.id),
  });
}

describe('PR-B 匿名开关 × 接口', () => {
  it('四种组合：作答页只差两个键，报告文本只差角色键，其余接口完全相同', async () => {
    const s = await answered('b06a');
    const { w } = s;
    await w.ok(w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P2.id] } }));
    await w.transition(s.activity.id, 'disable');
    const baseline = await invariant(s);
    const p2 = my(w, s.user.P2);
    const todo = (await w.ok<{ items: TodoView[] }>(p2('GET', '/todos'))).items[0]!;
    let hour = 1;
    for (const a of [true, false])
      for (const b of [true, false]) {
        await setA(s, a);
        await setB(s, b);
        // 作答页：链接与待办同一页面
        for (const page of [
          await w.ok<Record<string, unknown>>(w.link(await w.token(s.activity.id, s.person.P1.id))('GET', '')),
          await w.ok<Record<string, unknown>>(p2('GET', `/todos/${todo.id}/answer`)),
        ]) {
          expect('appraiser' in page, `A=${a}`).toBe(a);
          const task = (page.tasks as Record<string, unknown>[])[0]!;
          expect('role' in task, `A=${a}`).toBe(a);
          expect(JSON.stringify(page)).not.toContain(s.person.M.id);
        }
        // 报告：重新生成（2 小时一次）后文本答案的角色键随 B
        hour += 3;
        w.setNow(`2026-10-01T${String(hour).padStart(2, '0')}:00:00Z`);
        await w.ok(w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} }));
        const [row] = await reports(s);
        const report = await w.ok<{ questionnaires: { openFeedback: Record<string, unknown>[] }[] }>(
          w.request('GET', `${s.path}/reports/${row!.id}`),
        );
        for (const answer of report.questionnaires[0]!.openFeedback) expect('roleName' in answer, `B=${b}`).toBe(b);
        expect(await invariant(s), `A=${a} B=${b}`).toBe(baseline);
      }
  });
});

describe('PR-B 受限管理员与无授权管理员', () => {
  it('精细化开启：进程控制、原始数据、报告、报表只含范围内；范围外 404', async () => {
    const s = await answered('b06b');
    const { w } = s;
    const orgB = await w.session.org('乙部门', { establishedOn: '2025-01-01' });
    const outsider = await hire(w, '乙部门同事', orgB.id);
    const outsideTarget = await hire(w, '乙部门评价对象', orgB.id);
    await w.ok(w.request('POST', '/people/sync', { body: {} }));
    const people = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
    const personOf = (id: string) => people.find((p) => p.employeeId === id)!;
    await w.transition(s.activity.id, 'disable');
    const extra = await w.appraiser(s.activity.id, s.object.id, personOf(outsider.id).id, 'peer');
    const outsideObject = await w.object(s.activity.id, personOf(outsideTarget.id).id, [s.q.id]);
    const outsideSelf = await w.appraiser(s.activity.id, outsideObject.id, personOf(outsideTarget.id).id, 'self');
    await w.transition(s.activity.id, 'enable');
    await s.answerAs(personOf(outsider.id).id, extra.id, ['v2', 'v2', 'v2']);
    await s.answerAs(personOf(outsideTarget.id).id, outsideSelf.id, ['v4', 'v4', 'v4']);
    await w.transition(s.activity.id, 'disable');
    await w.ok(w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} }));

    const mou = await w.ok<{ id: string }>(
      w.enterprise('POST', '/mous', {
        ifMatch: 0,
        body: { code: `mou-b06b`, name: '甲部门', orgRanges: [{ orgId: s.org.id, includeDescendants: true }] },
      }),
      201,
    );
    const admin = await w.member('受限管理员');
    await w.appoint(admin, 'advanced');
    await w.ok(
      w.enterprise('PUT', `/scopes/${admin}/${survey360.SURVEY360_APP}`, {
        ifMatch: 0,
        body: { kind: 'mou', mouId: mou.id },
      }),
    );
    const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
    await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
    const current = await w.getActivity(s.activity.id);
    await w.ok(w.request('POST', `${s.path}/grants`, { ifMatch: current.revision, body: { userIds: [admin] } }));
    const as = w.as(admin);

    const view = await progress(s, admin);
    expect(view.items.map((i) => i.personId)).not.toContain(personOf(outsider.id).id);
    expect(view.items.map((i) => i.personId)).not.toContain(personOf(outsideTarget.id).id);
    // 范围内：T、M、P1、P2；外部客户（无员工、无汇报关系）与乙部门两人都在范围外（fail-closed）
    expect(view.total.all).toBe(4);
    expect((await as('GET', `${s.path}/progress/${personOf(outsider.id).id}`)).status).toBe(404);
    // DEC-358②：受限管理员（被授权、非创建者）看不到逐份卡片，只看汇总（报告、报表仍只含范围内）
    const cards = await as('GET', `${s.path}/sheets`);
    expect(cards.status).toBe(403);
    expect((await errorOf(cards)).details?.reason).toBe('SHEET_CARDS_RESTRICTED');
    expect((await reports(s, admin)).map((r) => r.objectId)).toEqual([s.object.id]);
    const tables = await w.ok<{ items: { objectId: string }[] }>(
      as('GET', `${s.path}/score-tables?level=questionnaire`),
    );
    expect(tables.items.map((i) => i.objectId)).toEqual([s.object.id]);
    const outsideCard = (await sheets(s)).find((c) => c.objectId === outsideObject.id)!;
    // 按编号屏蔽同样先按卡片查看人判定（DEC-358②），范围外的卡片与范围内的一样拿不到
    expect(
      (await as('POST', `${s.path}/sheets/${outsideCard.id}/block`, { ifMatch: outsideCard.revision })).status,
    ).toBe(403);
    expect((await as('POST', `${s.path}/relations/${outsideSelf.id}/reanswer`, { ifMatch: 1 })).status).toBe(404);
    expect((await as('GET', `${s.path}/reports/${randomUUID()}`)).status).toBe(404);
  });

  it('无该活动授权的管理员：PR-B 全部管理端接口 404', async () => {
    const s = await answered('b06c');
    const outsider = await s.w.member('无授权一般管理员');
    await s.w.appoint(outsider, 'general');
    for (const [method, path] of [
      ['GET', '/progress'],
      ['GET', `/progress/${s.person.P1.id}`],
      ['GET', '/sheets'],
      ['POST', '/sheets/block-suspected'],
      ['POST', '/todos'],
      ['POST', '/todos/cancel'],
      ['POST', '/invitations'],
      ['GET', '/reports'],
      ['POST', '/reports/forward/preview'],
      ['GET', '/score-tables?level=questionnaire'],
    ] as const) {
      const opts = method === 'GET' ? {} : { idempotencyKey: key(), body: {} };
      const res = await s.w.as(outsider)(method, `${s.path}${path}`, opts);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('PR-B 审计查看', () => {
  it('答卷类日志给有活动授权的管理员（脱敏，DEC-340③）；没有活动授权的一般管理员看不到', async () => {
    const s = await answered('b06d');
    const { w } = s;
    await w.transition(s.activity.id, 'disable');
    const card = (await sheets(s))[0]!;
    await w.ok(w.request('POST', `${s.path}/sheets/${card.id}/block`, { ifMatch: card.revision }));
    const row = (await progressDetail(s, s.person.P1.id)).items[0]!;
    await w.ok(w.request('POST', `${s.path}/relations/${row.relationId}/reanswer`, { ifMatch: row.revision }));
    const general = await w.member('一般管理员');
    await w.appoint(general, 'general');
    const outsider = await w.member('无授权管理员');
    await w.appoint(outsider, 'general');
    const current = await w.getActivity(s.activity.id);
    await w.ok(w.request('POST', `${s.path}/grants`, { ifMatch: current.revision, body: { userIds: [general] } }));

    const audit = auditApi(w.db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
    const types = async (user: string) =>
      (await audit.dataChanges({ user, tenant: w.tenantId }, { limit: '100' })).items
        .filter((i) => i.objectType === 'survey360-sheet')
        .map((i) => i.action);
    const system = await types(w.admin);
    for (const action of ['survey360.sheet.submit', 'survey360.sheet.block', 'survey360.sheet.clear'])
      expect(system).toContain(action);
    const granted = await types(general);
    for (const action of ['survey360.sheet.submit', 'survey360.sheet.block', 'survey360.sheet.clear'])
      expect(granted).toContain(action);
    expect(await types(outsider)).toEqual([]);
  });
});
