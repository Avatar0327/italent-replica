/**
 * AC-360-01 / 02 / 09：套卷数量上限、他评权重全为 0 不能启用、已使用的套卷不能删除（`25` E3-R2、E3-R3、E3-R5）。
 * 负向用例断言具体响应码，并前后各读一次比对，证明数据未被改动。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type QuestionnaireView, world360 } from './AC-360-support.js';

const testDb = useTestDb();

describe('AC-360-01 一个评价对象最多 3 个套卷', () => {
  it('选第 4 个套卷被拒绝（400），对象的套卷保持不变', async () => {
    const w = await world360(testDb().db, 'q01');
    const qs: QuestionnaireView[] = [];
    for (let i = 0; i < 4; i++) qs.push(await w.enableQuestionnaire(await w.keyBehavior()));
    const activity = await w.activity();
    const person = await w.person('对象甲');
    const four = await w.request('POST', `/activities/${activity.id}/objects`, {
      ifMatch: 0,
      body: { personId: person.id, questionnaireIds: qs.map((q) => q.id) },
    });
    expect(four.status).toBe(400);
    expect(((await four.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'TOO_MANY_QUESTIONNAIRES',
    );
    const object = await w.object(
      activity.id,
      person.id,
      qs.slice(0, 3).map((q) => q.id),
    );
    const before = await w.ok<{ items: { id: string; questionnaireIds: string[] }[] }>(
      w.request('GET', `/activities/${activity.id}/objects`),
    );
    const change = await w.request('PUT', `/activities/${activity.id}/objects/${object.id}/questionnaires`, {
      ifMatch: object.revision,
      body: { questionnaireIds: qs.map((q) => q.id) },
    });
    expect(change.status).toBe(400);
    const empty = await w.request('PUT', `/activities/${activity.id}/objects/${object.id}/questionnaires`, {
      ifMatch: object.revision,
      body: { questionnaireIds: [] },
    });
    expect(empty.status).toBe(400);
    const after = await w.ok<typeof before>(w.request('GET', `/activities/${activity.id}/objects`));
    expect(after).toEqual(before);
    expect(after.items[0]!.questionnaireIds).toHaveLength(3);
  });

  it('只能选已启用的套卷（草稿套卷被拒绝）', async () => {
    const w = await world360(testDb().db, 'q01b');
    const draft = await w.keyBehavior();
    const activity = await w.activity();
    const person = await w.person('对象乙');
    const res = await w.request('POST', `/activities/${activity.id}/objects`, {
      ifMatch: 0,
      body: { personId: person.id, questionnaireIds: [draft.id] },
    });
    expect(res.status).toBe(409);
    expect((await w.ok<{ items: unknown[] }>(w.request('GET', `/activities/${activity.id}/objects`))).items).toEqual(
      [],
    );
  });
});

describe('AC-360-02 他评角色权重全为 0 不能启用', () => {
  it('启用被拒绝（400，OTHER_ROLE_WEIGHTS_ZERO），套卷仍为草稿', async () => {
    const w = await world360(testDb().db, 'q02');
    const q = await w.keyBehavior({ self: 0, superior: 0, peer: 0 });
    const res = await w.request('POST', `/questionnaires/${q.id}/enable`, { ifMatch: q.revision });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { issues: { code: string }[] } } };
    expect(body.error.details.issues.map((i) => i.code)).toContain('OTHER_ROLE_WEIGHTS_ZERO');
    const after = await w.ok<QuestionnaireView>(w.request('GET', `/questionnaires/${q.id}`));
    expect(after.status).toBe('draft');
    expect(after.revision).toBe(q.revision);
  });

  it('自评权重固定为 0；单套卷最多 15 个角色', async () => {
    const w = await world360(testDb().db, 'q02b');
    const self = await w.keyBehavior({ self: 1, superior: 5 });
    const res = await w.request('POST', `/questionnaires/${self.id}/enable`, { ifMatch: self.revision });
    expect(res.status).toBe(400);
    const codes = ((await res.json()) as { error: { details: { issues: { code: string }[] } } }).error.details.issues;
    expect(codes.map((i) => i.code)).toContain('SELF_WEIGHT_NOT_ZERO');
    for (let i = 0; i < 14; i++) {
      const created = await w.ok<{ id: string; code: null; name: string }>(
        w.request('POST', '/roles', { ifMatch: 0, body: { name: `自定义角色${i}` } }),
        201,
      );
      w.roles.push(created);
    }
    const many = await w.keyBehavior({});
    const content = w.keyBehaviorContent({ self: 0, superior: 1 });
    const roles = [
      ...content.roles,
      ...w.roles.filter((r) => r.code === null).map((r) => ({ key: r.id, roleId: r.id, weight: 1 })),
    ];
    const tooMany = await w.request('PUT', `/questionnaires/${many.id}`, {
      ifMatch: many.revision,
      body: { content: { ...content, roles } },
    });
    expect(tooMany.status).toBe(400);
    expect(roles).toHaveLength(16);
  });
});

describe('AC-360-09 已使用的套卷不能删除', () => {
  it('活动启用后套卷变为已使用，删除返回 409 且套卷仍在', async () => {
    const w = await world360(testDb().db, 'q09');
    const q = await w.enableQuestionnaire(await w.keyBehavior());
    const activity = await w.activity();
    const target = await w.person('对象丙');
    const boss = await w.person('上级丙');
    const object = await w.object(activity.id, target.id, [q.id]);
    await w.appraiser(activity.id, object.id, boss.id, 'superior');
    await w.transition(activity.id, 'enable');
    const used = await w.ok<QuestionnaireView>(w.request('GET', `/questionnaires/${q.id}`));
    expect(used.status).toBe('used');
    const res = await w.request('DELETE', `/questionnaires/${q.id}`, { ifMatch: used.revision });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'QUESTIONNAIRE_USED',
    );
    expect(await w.ok<QuestionnaireView>(w.request('GET', `/questionnaires/${q.id}`))).toEqual(used);
  });

  it('已使用的套卷不能改结构；活动停用时可改文字与权重（E3-R2、E3-R15）', async () => {
    const w = await world360(testDb().db, 'q09b');
    const q = await w.enableQuestionnaire(await w.keyBehavior());
    const activity = await w.activity();
    const object = await w.object(activity.id, (await w.person('对象丁')).id, [q.id]);
    await w.appraiser(activity.id, object.id, (await w.person('上级丁')).id, 'superior');
    await w.transition(activity.id, 'enable');
    const used = await w.ok<QuestionnaireView>(w.request('GET', `/questionnaires/${q.id}`));
    const content = w.keyBehaviorContent({ self: 0, superior: 5, peer: 3, subordinate: 2 });
    const whileEnabled = await w.request('PUT', `/questionnaires/${q.id}`, {
      ifMatch: used.revision,
      body: { content: { ...content, roles: content.roles.map((r) => ({ ...r, weight: r.key === 'self' ? 0 : 1 })) } },
    });
    expect(whileEnabled.status).toBe(409);
    await w.transition(activity.id, 'disable');
    const structural = await w.request('PUT', `/questionnaires/${q.id}`, {
      ifMatch: used.revision,
      body: { content: { ...content, questions: content.questions.slice(0, 1) } },
    });
    expect(structural.status).toBe(409);
    const reweighted = await w.ok<QuestionnaireView>(
      w.request('PUT', `/questionnaires/${q.id}`, {
        ifMatch: used.revision,
        body: {
          content: { ...content, roles: content.roles.map((r) => ({ ...r, weight: r.key === 'self' ? 0 : 1 })) },
        },
      }),
    );
    expect(reweighted.roles.find((r) => r.key === 'superior')!.weight).toBe(1);
    expect(reweighted.questions.map((x) => x.id)).toEqual(used.questions.map((x) => x.id));
  });
});
