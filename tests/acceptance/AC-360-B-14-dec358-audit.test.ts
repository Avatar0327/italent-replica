/**
 * DEC-358② 覆盖审计出口（PR #125 第 4 轮审查 P2-1）：逐份答卷的答案（逐题选项 / 文本、发展建议）只给逐份卡片的查看人
 * ——持“全部活动”的管理员或该活动的创建者，且本人不兼任该活动的被评价人 / 评价者。其他活动管理员与兼任者在答卷
 * 日志里（列表 changes / content、详情 before / after / snapshot）都看不到答案，按答案字段筛选也查不到；身份脱敏
 * （DEC-340③ / DEC-355②）与答案可见性分别判断：活动创建者看得到答案，但仍看不到评价关系、答卷编号与命令 ID。
 * P3-1：完整版查看人按 relationId 筛选能查到答卷日志（字段筛选与展示用同一字段集合）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { key, progressDetail, sceneB, type SceneB } from './AC-360-B-support.js';

const testDb = useTestDb();

/** 自评、同事 P1 提交（带建议与文本答案），同事 P2 只保存；停用后清除 P1 重新作答。 */
async function scene(label: string) {
  const s = await sceneB(testDb().db, label);
  const { w } = s;
  await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4'], { suggestion: '自评建议', remark: '自评备注' });
  await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v3', 'v4'], { suggestion: '同事建议', remark: '同事备注' });
  await s.answerAs(s.person.P2.id, s.rel.p2.id, ['v2', 'v5', 'v3'], { suggestion: '暂存建议', submit: false });
  await w.transition(s.activity.id, 'disable');
  const row = (await progressDetail(s, s.person.P1.id)).items[0]!;
  await w.ok(w.request('POST', `${s.path}/relations/${row.relationId}/reanswer`, { ifMatch: row.revision }));
  return s;
}

async function grantActivity(s: SceneB, activityId: string, user: string) {
  const current = await s.w.getActivity(activityId);
  await s.w.ok(
    s.w.request('POST', `/activities/${activityId}/grants`, { ifMatch: current.revision, body: { userIds: [user] } }),
  );
}

async function sheetEvents(s: SceneB, user: string, query: Record<string, string> = {}) {
  const audit = auditApi(s.w.db, '2026-10-01T02:00:00Z', { authorize: s.w.authorize });
  const as = { user, tenant: s.w.tenantId };
  const items = (await audit.dataChanges(as, { limit: '100', ...query })).items.filter(
    (i) => i.objectType === 'survey360-sheet',
  );
  return Promise.all(items.map(async (item) => ({ item, detail: await audit.dataChange(as, item.id) })));
}

/** 逐份答案的痕迹：答案 / 建议字段名、选项编号、文本答案与建议原文。 */
function answerMarkers(s: SceneB): string[] {
  return [
    '"answers"',
    '"suggestion"',
    '"optionId"',
    '"remark"',
    ...s.q.scales[0]!.options.map((o) => o.id),
    '自评建议',
    '自评备注',
    '同事建议',
    '同事备注',
    '暂存建议',
  ];
}

async function expectNoAnswers(s: SceneB, user: string) {
  const events = await sheetEvents(s, user);
  const actions = new Set(events.map((e) => e.item.action));
  // 提交、清除仍可见（状态变化），只是没有答案
  for (const action of ['survey360.sheet.submit', 'survey360.sheet.clear']) expect(actions, action).toContain(action);
  for (const { item, detail } of events) {
    const text = JSON.stringify([item, detail]);
    for (const marker of answerMarkers(s)) expect(text, `${item.action} ${marker}`).not.toContain(marker);
  }
  for (const field of ['answers', 'suggestion'])
    expect(await sheetEvents(s, user, { field }), `按 ${field} 筛选`).toEqual([]);
}

describe('DEC-358② 答卷日志里的逐份答案', () => {
  it('被授权的一般活动管理员（非创建者）：保存 / 提交 / 清除日志都不带答案，按答案字段筛选查不到', async () => {
    const s = await scene('d358au-a');
    const general = await s.w.member('一般活动管理员');
    await s.w.appoint(general, 'general');
    await grantActivity(s, s.activity.id, general);
    await expectNoAnswers(s, general);
  });

  it('兼任本活动被评价人 / 评价者的“全部活动”持有人看不到答案', async () => {
    const s = await scene('d358au-b');
    for (const user of [s.user.T, s.user.M]) {
      await s.w.appoint(user, 'system');
      await expectNoAnswers(s, user);
    }
  });

  it('活动创建者（一般管理员）不兼任时看得到答案、仍看不到评价关系；兼任评价者时看不到答案', async () => {
    const s = await scene('d358au-c');
    const { w } = s;
    const creator = await w.member('活动创建者');
    await w.appoint(creator, 'general');
    const own = await activityBy(s, creator, s.person.M.id, '创建者建议');
    const events = (await sheetEvents(s, creator)).filter((e) => JSON.stringify(e.detail.after).includes(own.id));
    const submit = events.find((e) => e.item.action === 'survey360.sheet.submit');
    expect(submit, '创建者看得到提交日志').toBeDefined();
    const text = JSON.stringify(events);
    expect(text).toContain('"optionId"');
    expect(text).toContain('创建者建议');
    expect(text).not.toContain('"relationId"');
    expect(submit!.item.objectId).toBeNull();
    expect(submit!.item.commandId).toBeNull();
    expect((await sheetEvents(s, creator, { field: 'answers' })).length).toBeGreaterThan(0);

    // 上级 M 创建的活动里自己当上级评价者：看不到答案
    await w.appoint(s.user.M, 'general');
    const participating = await activityBy(s, s.user.M, s.person.M.id, '兼任建议');
    const mine = (await sheetEvents(s, s.user.M)).filter((e) =>
      JSON.stringify(e.detail.after).includes(participating.id),
    );
    expect(mine.map((e) => e.item.action)).toContain('survey360.sheet.submit');
    const leaked = JSON.stringify(mine);
    for (const marker of ['"answers"', '"optionId"', '"suggestion"', '兼任建议']) expect(leaked).not.toContain(marker);
  });

  it('完整版查看人看得到答案，按 relationId 筛选也查得到（P3-1）', async () => {
    const s = await scene('d358au-d');
    const { w } = s;
    const events = await sheetEvents(s, w.admin);
    const text = JSON.stringify(events);
    expect(text).toContain('同事建议');
    expect(text).toContain('"optionId"');
    const byRelation = await sheetEvents(s, w.admin, { field: 'relationId' });
    expect(byRelation.map((e) => e.item.action)).toContain('survey360.sheet.save');
    expect((await sheetEvents(s, w.admin, { field: 'answers' })).length).toBeGreaterThan(0);
  });
});

/** creator 创建的活动：评价对象 T，评价者 P1（同事）与上级，作答（带建议）后停用。 */
async function activityBy(s: SceneB, creator: string, superiorPersonId: string, suggestion: string) {
  const { w } = s;
  const activity = await w.activity({ name: `创建者活动${key().slice(0, 4)}` }, creator);
  const object = await w.object(activity.id, s.person.T.id, [s.q.id]);
  const peer = await w.appraiser(activity.id, object.id, s.person.P1.id, 'peer');
  const superior = await w.appraiser(activity.id, object.id, superiorPersonId, 'superior');
  await w.transition(activity.id, 'enable');
  const options = s.q.scales[0]!.options;
  for (const [personId, relation] of [
    [s.person.P1.id, peer],
    [superiorPersonId, superior],
  ] as const) {
    const call = w.link(await w.token(activity.id, personId));
    const answers = s.q.questions.map((question) => ({ itemId: question.id, optionId: options[0]!.id }));
    const saved = await w.ok<{ revision: number }>(
      call('PUT', `/tasks/${relation.id}/questionnaires/${s.q.id}`, { ifMatch: 0, body: { answers, suggestion } }),
    );
    await w.ok(call('POST', `/tasks/${relation.id}/questionnaires/${s.q.id}/submit`, { ifMatch: saved.revision }));
  }
  await w.transition(activity.id, 'disable');
  return activity;
}
