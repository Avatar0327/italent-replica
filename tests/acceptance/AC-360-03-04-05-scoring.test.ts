/**
 * AC-360-03 / 04 / 05：角色加权计分（E3-R11）、缺失角色从分母去掉（E3-R13）、“不做评价”不计入统计（E3-R6）。
 * 计分在停用活动后进行（E3-R15）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { overall, type World360, world360 } from './AC-360-support.js';

const testDb = useTestDb();

async function scenario(w: World360, raters: { role: string; picks: [string, string] }[]) {
  const q = await w.enableQuestionnaire(await w.keyBehavior());
  const activity = await w.activity();
  const target = await w.person('评价对象');
  const object = await w.object(activity.id, target.id, [q.id]);
  const relations = [];
  for (const [index, rater] of raters.entries()) {
    const person = rater.role === 'self' ? target : await w.person(`评价者${index}`);
    relations.push({ person, relation: await w.appraiser(activity.id, object.id, person.id, rater.role), rater });
  }
  await w.transition(activity.id, 'enable');
  for (const { person, relation, rater } of relations) {
    const res = await w.answer(await w.token(activity.id, person.id), relation.id, q, rater.picks);
    expect((res as Response).status, await (res as Response).clone().text()).toBe(200);
  }
  await w.transition(activity.id, 'disable');
  return { q, activity, object, rows: await w.scores(activity.id, object.id) };
}

describe('AC-360-03 角色加权：上 5 / 同 3 / 下 2', () => {
  it('角色分 3.5 / 4.0 / 4.3 → 他评分 3.81', async () => {
    const w = await world360(testDb().db, 's03');
    const { rows } = await scenario(w, [
      { role: 'superior', picks: ['v3.5', 'v3.5'] },
      { role: 'peer', picks: ['v4', 'v4'] },
      { role: 'peer', picks: ['v3.5', 'v4.3'] },
      { role: 'subordinate', picks: ['v4.3', 'v4.3'] },
      { role: 'self', picks: ['v5', 'v5'] },
    ]);
    expect(overall(rows, 'role', w.role('superior'))).toBeCloseTo(3.5, 6);
    expect(overall(rows, 'role', w.role('peer'))).toBeCloseTo(3.95, 6);
    expect(overall(rows, 'role', w.role('subordinate'))).toBeCloseTo(4.3, 6);
    // (3.5×5 + 3.95×3 + 4.3×2) / 10
    expect(overall(rows, 'other')).toBeCloseTo(3.795, 6);
    expect(overall(rows, 'self')).toBeCloseTo(5, 6);
  });

  it('规格原例：角色分恰为 3.5 / 4.0 / 4.3 时他评分 3.81', async () => {
    const w = await world360(testDb().db, 's03b');
    const { rows } = await scenario(w, [
      { role: 'superior', picks: ['v3.5', 'v3.5'] },
      { role: 'peer', picks: ['v4', 'v4'] },
      { role: 'subordinate', picks: ['v4.3', 'v4.3'] },
    ]);
    expect(Number(overall(rows, 'other')!.toFixed(2))).toBe(3.81);
    // 同事只有 1 名评价者时同样单列该角色分数（DEC-149：不按人数隐藏）
    const peer = rows.find((r) => r.level === 'questionnaire' && r.roleId === w.role('peer'))!;
    expect(peer).toMatchObject({ score: 4, raterCount: 1 });
  });
});

describe('AC-360-04 缺失角色', () => {
  it('无下级评价者：权重从分母去掉，他评分 3.69', async () => {
    const w = await world360(testDb().db, 's04');
    const { rows } = await scenario(w, [
      { role: 'superior', picks: ['v3.5', 'v3.5'] },
      { role: 'peer', picks: ['v4', 'v4'] },
    ]);
    expect(Number(overall(rows, 'other')!.toFixed(2))).toBe(3.69);
    expect(rows.some((r) => r.roleId === w.role('subordinate'))).toBe(false);
  });
});

describe('AC-360-05 不做评价', () => {
  it('选“不做评价”的题目不计入统计（不按 0 分算）', async () => {
    const w = await world360(testDb().db, 's05');
    const { q, rows } = await scenario(w, [{ role: 'superior', picks: ['v4', 'none'] }]);
    expect(overall(rows, 'role', w.role('superior'))).toBeCloseTo(4, 6);
    const second = rows.find((r) => r.level === 'question' && r.itemId === q.questions[1]!.id && r.scope === 'other');
    expect(second).toBeUndefined();
    const first = rows.find((r) => r.level === 'question' && r.itemId === q.questions[0]!.id && r.scope === 'other');
    expect(first?.score).toBeCloseTo(4, 6);
  });
});
