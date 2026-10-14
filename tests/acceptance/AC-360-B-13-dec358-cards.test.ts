/**
 * DEC-358②（PR #125 第 4 轮 P2-1 修法）：逐份匿名答卷卡片（逐份分数 / 答案）只给两类人看——持“全部活动”的管理员、
 * 该活动的创建者；两类人在该活动里兼任被评价人 / 评价者时同样看不到（与 DEC-355② 的兼任规则一致）。其他活动管理员
 * 只看各题汇总（结果报表、报告不受影响），看不到卡片列表，也不能按答卷编号屏蔽 / 取消屏蔽（会返回单张卡片）。
 * 这样能“按具名关系重新作答”的一般活动管理员拿不到清除前后的卡片，第 3 轮审查复现的差分认不出 P1 的答卷。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, key, progressDetail, sceneB, type SceneB, sheets } from './AC-360-B-support.js';

const testDb = useTestDb();

async function answered(label: string) {
  const s = await sceneB(testDb().db, label);
  await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4']);
  await s.answerAs(s.person.M.id, s.rel.superior.id, ['v3', 'v4', 'v5']);
  await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v3', 'v4']);
  await s.answerAs(s.person.P2.id, s.rel.p2.id, ['v2', 'v5', 'v3']);
  await s.w.transition(s.activity.id, 'disable');
  return s;
}

async function grant(s: SceneB, activityId: string, user: string) {
  const current = await s.w.getActivity(activityId);
  await s.w.ok(
    s.w.request('POST', `/activities/${activityId}/grants`, { ifMatch: current.revision, body: { userIds: [user] } }),
  );
}

const cardsOf = (s: SceneB, activityId: string, user: string) =>
  s.w.as(user)('GET', `/activities/${activityId}/sheets`);

async function expectRestricted(res: Response, what: string) {
  expect(res.status, what).toBe(403);
  expect((await errorOf(res)).details?.reason, what).toBe('SHEET_CARDS_RESTRICTED');
}

/** creator 创建的活动：评价对象 T，评价者 P1（同事）与 extra（上级），全部作答后停用。 */
async function activityBy(s: SceneB, creator: string, superiorPersonId: string) {
  const { w } = s;
  const activity = await w.activity({ name: `创建者活动${key().slice(0, 4)}` }, creator);
  const object = await w.object(activity.id, s.person.T.id, [s.q.id]);
  const peer = await w.appraiser(activity.id, object.id, s.person.P1.id, 'peer');
  const superior = await w.appraiser(activity.id, object.id, superiorPersonId, 'superior');
  await w.transition(activity.id, 'enable');
  for (const [personId, relation] of [
    [s.person.P1.id, peer],
    [superiorPersonId, superior],
  ] as const)
    await w.ok(
      (await w.answer(await w.token(activity.id, personId), relation.id, s.q, ['v4', 'v3', 'v4'])) as Response,
    );
  await w.transition(activity.id, 'disable');
  return activity;
}

describe('DEC-358② 逐份答卷卡片的可见范围', () => {
  it('持“全部活动”且不兼任的人看卡片；一般活动管理员只看汇总，卡片列表与按编号屏蔽都 403', async () => {
    const s = await answered('d358a');
    const { w } = s;
    const cards = await sheets(s, w.admin);
    expect(cards.length).toBeGreaterThan(0);

    const general = await w.member('一般活动管理员');
    await w.appoint(general, 'general');
    await grant(s, s.activity.id, general);
    await expectRestricted(await cardsOf(s, s.activity.id, general), '卡片列表');
    const card = cards[0]!;
    await expectRestricted(
      await w.as(general)('POST', `${s.path}/sheets/${card.id}/block`, { ifMatch: card.revision }),
      '按编号屏蔽',
    );
    // 汇总不受影响
    await w.ok(w.as(general)('GET', `${s.path}/score-tables?level=questionnaire`));
  });

  it('兼任本活动被评价人 / 评价者的“全部活动”持有人只看汇总', async () => {
    const s = await answered('d358b');
    for (const user of [s.user.T, s.user.M]) {
      await s.w.appoint(user, 'system');
      await expectRestricted(await cardsOf(s, s.activity.id, user), user);
    }
  });

  it('活动创建者（一般管理员）不兼任时看卡片，兼任评价者时只看汇总', async () => {
    const s = await answered('d358c');
    const { w } = s;
    const creator = await w.member('活动创建者');
    await w.appoint(creator, 'general');
    const own = await activityBy(s, creator, s.person.M.id);
    const res = await cardsOf(s, own.id, creator);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
    // 创建者在自己的活动里当上级评价者：只看汇总
    await w.appoint(s.user.M, 'general');
    const participating = await activityBy(s, s.user.M, s.person.M.id);
    await expectRestricted(await cardsOf(s, participating.id, s.user.M), '兼任评价者的创建者');
  });

  it('第 3 轮差分反例不再成立：一般活动管理员重新作答前后都拿不到卡片', async () => {
    const s = await answered('d358d');
    const { w } = s;
    const general = await w.member('重新作答的管理员');
    await w.appoint(general, 'general');
    await grant(s, s.activity.id, general);
    await expectRestricted(await cardsOf(s, s.activity.id, general), '重新作答前');
    const row = (await progressDetail(s, s.person.P1.id, general)).items[0]!;
    await w.ok(
      w.as(general)('POST', `${s.path}/relations/${row.relationId}/reanswer`, {
        ifMatch: row.revision,
        idempotencyKey: key(),
      }),
    );
    await expectRestricted(await cardsOf(s, s.activity.id, general), '重新作答后');
  });
});
