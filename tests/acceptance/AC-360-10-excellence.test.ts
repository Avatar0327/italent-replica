/**
 * AC-360-10 优秀率控制（E3-R9，仅一次评价多人）：12 人、优秀线 90%、上限 20% → 至多 ⌈12×20%⌉ = 3 人 ≥ 90%。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { world360 } from './AC-360-support.js';

const testDb = useTestDb();

describe('AC-360-10 优秀率控制', () => {
  it('第 4 个 ≥90 分的答卷不能提交（400），未达优秀线的照常提交', async () => {
    const w = await world360(testDb().db, 'x10');
    const q = await w.enableQuestionnaire(
      await w.keyBehavior({ self: 0, superior: 1 }, { excellence: { linePercent: 90, maxRate: 20 } }),
    );
    const activity = await w.activity({ form: 'multiple' });
    const boss = await w.person('评价者');
    const relations = [];
    for (let i = 0; i < 12; i++) {
      const object = await w.object(activity.id, (await w.person(`对象${i}`)).id, [q.id]);
      relations.push(await w.appraiser(activity.id, object.id, boss.id, 'superior'));
    }
    await w.transition(activity.id, 'enable');
    const token = await w.token(activity.id, boss.id);
    for (const relation of relations.slice(0, 3)) {
      expect(((await w.answer(token, relation.id, q, ['v5', 'v4'])) as Response).status).toBe(200);
    }
    const fourth = (await w.answer(token, relations[3]!.id, q, ['v5', 'v5'])) as Response;
    expect(fourth.status).toBe(400);
    expect(((await fourth.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'EXCELLENT_RATE_EXCEEDED',
    );
    const sheet = await w.ok<{ sheet: { status: string } }>(
      w.link(token)('GET', `/tasks/${relations[3]!.id}/questionnaires/${q.id}`),
    );
    expect(sheet.sheet.status).toBe('draft');
    expect(((await w.answer(token, relations[4]!.id, q, ['v4', 'v4'])) as Response).status).toBe(200);
  });

  it('一次评价一人的活动不做优秀率控制', async () => {
    const w = await world360(testDb().db, 'x10b');
    const q = await w.enableQuestionnaire(
      await w.keyBehavior({ self: 0, superior: 1 }, { excellence: { linePercent: 90, maxRate: 20 } }),
    );
    const activity = await w.activity({ form: 'single' });
    const boss = await w.person('评价者');
    const relations = [];
    for (let i = 0; i < 5; i++) {
      const object = await w.object(activity.id, (await w.person(`对象${i}`)).id, [q.id]);
      relations.push(await w.appraiser(activity.id, object.id, boss.id, 'superior'));
    }
    await w.transition(activity.id, 'enable');
    const token = await w.token(activity.id, boss.id);
    for (const relation of relations) {
      expect(((await w.answer(token, relation.id, q, ['v5', 'v5'])) as Response).status).toBe(200);
    }
  });

  it('并发提交：两份同时达到优秀线的答卷只有一份能过上限（按评价者串行判定）', async () => {
    const w = await world360(testDb().db, 'x10c');
    const q = await w.enableQuestionnaire(
      await w.keyBehavior({ self: 0, superior: 1 }, { excellence: { linePercent: 90, maxRate: 20 } }),
    );
    const activity = await w.activity({ form: 'multiple' });
    const boss = await w.person('评价者');
    const relations = [];
    for (let i = 0; i < 5; i++) {
      const object = await w.object(activity.id, (await w.person(`对象${i}`)).id, [q.id]);
      relations.push(await w.appraiser(activity.id, object.id, boss.id, 'superior'));
    }
    await w.transition(activity.id, 'enable');
    const token = await w.token(activity.id, boss.id);
    const call = w.link(token);
    const options = q.scales[0]!.options;
    const full = q.questions.map((question) => ({ itemId: question.id, optionId: options.at(-2)!.id }));
    const saved: { revision: number }[] = [];
    for (const relation of relations.slice(0, 2))
      saved.push(
        await w.ok<{ revision: number }>(
          call('PUT', `/tasks/${relation.id}/questionnaires/${q.id}`, { ifMatch: 0, body: { answers: full } }),
        ),
      );
    const results = await Promise.all(
      relations
        .slice(0, 2)
        .map((relation, i) =>
          call('POST', `/tasks/${relation.id}/questionnaires/${q.id}/submit`, { ifMatch: saved[i]!.revision }),
        ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });
});
