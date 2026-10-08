/**
 * 360 写入口接入统一审计（DEC-216），审计查看按 360 身份与活动授权裁剪（audit/visibility.ts 登记）：
 * 有该活动访问权的 360 管理员可见；无该活动授权的一般管理员、非 360 管理员（即使持日志审计能力）都看不到，
 * 被评价人与评价者不能经审计查看反推评价者身份。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { world360 } from './AC-360-support.js';

const testDb = useTestDb();

describe('360 审计查看', () => {
  it('写入口留痕；按 360 身份与活动授权裁剪', async () => {
    const db = testDb().db;
    const w = await world360(db, 'aud');
    const q = await w.enableQuestionnaire(await w.keyBehavior());
    const activity = await w.activity({ name: '审计活动' });
    const target = await w.person('被评价人');
    const object = await w.object(activity.id, target.id, [q.id]);
    const rater = await w.person('评价者');
    const relation = await w.appraiser(activity.id, object.id, rater.id, 'superior');
    await w.transition(activity.id, 'enable');
    await w.answer(await w.token(activity.id, rater.id), relation.id, q, ['v4', 'v4']);

    const audit = auditApi(db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
    const as = (user: string) => ({ user, tenant: w.tenantId });
    const types = async (user: string) =>
      (await audit.dataChanges(as(user), { limit: '100' })).items
        .filter((i) => i.objectType.startsWith('survey360'))
        .map((i) => `${i.objectType}:${i.action}`);

    const system = await types(w.admin);
    for (const expected of [
      'survey360-person:survey360.person.create',
      'survey360-questionnaire:survey360.questionnaire.enable',
      'survey360-activity:survey360.activity.create',
      'survey360-activity:survey360.activity.enable',
      'survey360-object:survey360.object.create',
      'survey360-relation:survey360.relation.create',
      'survey360-sheet:survey360.sheet.submit',
    ])
      expect(system).toContain(expected);

    const general = await w.member('一般管理员');
    await w.appoint(general, 'general');
    const generalTypes = await types(general);
    expect(generalTypes.filter((t) => /activity|object|relation|sheet/.test(t))).toEqual([]);

    const outsider = await w.member('审计员');
    expect(await types(outsider)).toEqual([]);

    const current = await w.getActivity(activity.id);
    await w.ok(
      w.request('POST', `/activities/${activity.id}/grants`, {
        ifMatch: current.revision,
        body: { userIds: [general] },
      }),
    );
    // PR-B：答卷类日志（含答案与评价关系）只给持“全部活动”者，有活动授权的一般管理员看不到（身份保护）
    const granted = await types(general);
    expect(granted).toContain('survey360-relation:survey360.relation.create');
    expect(granted.filter((t) => t.startsWith('survey360-sheet'))).toEqual([]);
  });
});
