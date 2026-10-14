/** EV-R5：使用真实活动引用接 B4 的评分锁，状态 × 报名数；不以操作人的活动范围缩小锁集合。 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  activityFixtures,
  activityWorld,
  type ActivityFixtures,
  type ActivityWorld,
} from './AC-EV-activity-support.js';
import { errorOf, EV_BASE, ok } from './AC-EV-support.js';
import { FORMS, type FormView } from './AC-EV-form-support.js';

const testDb = useTestDb();
describe('AC-EV-form EV-R5 活动锁', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  beforeAll(async () => {
    w = await activityWorld(testDb().db);
    f = await activityFixtures(w);
  });
  const read = async (id: string) => ok<FormView>(await w.setup.request('GET', `${EV_BASE}${FORMS}/${id}`, w.asAdmin));
  const patch = (form: FormView, body: unknown) =>
    w.setup.request('PATCH', `${EV_BASE}${FORMS}/${form.id}`, {
      ...w.asAdmin,
      ifMatch: form.revision,
      body,
    });
  const using = async (formId: string) =>
    w.adminActivity(
      f.body({
        chains: f.chains(formId),
        categoryIds: [(await w.qlCategory()).id],
      }),
    );

  it.each([
    ['draft', 0, false],
    ['draft', 1, false],
    ['published', 0, false],
    ['published', 1, true],
    ['completed', 1, false],
  ] as const)('%s / apply_count=%i：锁定=%s', async (status, count, locked) => {
    const form = await w.form();
    const activity = await using(form.id);
    await w.setStatus(activity.id, status);
    await w.setApplyCount(activity.id, count);
    const before = await read(form.id);
    const response = await patch(before, { fullScore: 90 });
    expect(response.status).toBe(locked ? 409 : 200);
    if (locked) {
      expect((await errorOf(response)).reason).toBe('FORM_LOCKED');
      expect(await read(form.id)).toEqual(before);
    } else expect(await read(form.id)).toMatchObject({ fullScore: 90, revision: 2 });
  });

  it('评分方式、满分、通过分、总分规则与评分项均锁；名称与原样提交允许；其他未引用表不锁', async () => {
    const form = await w.form();
    const activity = await using(form.id);
    await w.setStatus(activity.id, 'published');
    await w.setApplyCount(activity.id, 2);
    const before = await read(form.id);
    for (const body of [
      { scoreMode: 'by_indicator', totalRule: 'average' },
      { fullScore: 90 },
      { passScore: 10 },
      { items: [{ kind: 'standard' }] },
    ]) {
      const response = await patch(before, body);
      expect(response.status, JSON.stringify(body)).toBe(409);
      expect((await errorOf(response)).reason).toBe('FORM_LOCKED');
      expect(await read(form.id)).toEqual(before);
    }
    const changed = await ok<FormView>(
      await patch(before, { name: '锁后改名称', fullScore: before.fullScore, items: [] }),
    );
    expect(changed).toMatchObject({ name: '锁后改名称', fullScore: 100, revision: 2 });
    const unused = await w.form();
    expect((await patch(await read(unused.id), { fullScore: 90 })).status).toBe(200);
  });

  it('投票参考评分：投票通过比例、参考评分、总分规则与标准项权重均纳入真实活动锁', async () => {
    const form = await ok<FormView>(
      await w.setup.request('POST', `${EV_BASE}${FORMS}`, {
        ...w.asAdmin,
        ifMatch: 0,
        body: {
          name: '投票参考表',
          ownerOrgId: w.orgA,
          scoreMode: 'by_vote',
          votePassRatio: 60,
          indicatorReference: true,
          fullScore: 100,
          passScore: 60,
          totalRule: 'average',
          items: [{ kind: 'standard', weight: 100 }],
        },
      }),
      201,
    );
    const activity = await using(form.id);
    await w.setStatus(activity.id, 'published');
    await w.setApplyCount(activity.id, 1);
    for (const body of [
      { votePassRatio: 70 },
      { indicatorReference: false },
      { totalRule: 'sum' },
      { items: [{ kind: 'standard', weight: 50 }] },
    ]) {
      const response = await patch(form, body);
      expect(response.status).toBe(409);
      expect((await errorOf(response)).reason).toBe('FORM_LOCKED');
      expect(await read(form.id)).toEqual(form);
    }
  });
});
