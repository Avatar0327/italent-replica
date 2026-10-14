/**
 * AC-360-11（DEC-027）：未同步任何组织员工，手工录入 3 个外部评价对象和评价者，完成一次活动：可正常作答、计分。
 * 个人报告属于 PR-B（R3-T03 第二部分），本文件覆盖作答与计分。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { overall, world360 } from './AC-360-support.js';

const testDb = useTestDb();

describe('AC-360-11 无组织员工数据时独立使用', () => {
  it('外部人员作评价对象与评价者，作答、停用后计分', async () => {
    const w = await world360(testDb().db, 'i11');
    const employees = await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM employment_employees`),
    );
    expect((Array.isArray(employees) ? employees : (employees as { rows: { n: number }[] }).rows)[0]).toEqual({ n: 0 });
    const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, customer: 1, other: 1 }));
    const activity = await w.activity();
    const targets = [await w.person('外部对象一'), await w.person('外部对象二'), await w.person('外部对象三')];
    const customer = await w.person('客户评价者');
    const other = await w.person('其他评价者');
    const objects = [];
    for (const target of targets) {
      const object = await w.object(activity.id, target.id, [q.id]);
      objects.push({
        object,
        customer: await w.appraiser(activity.id, object.id, customer.id, 'customer'),
        other: await w.appraiser(activity.id, object.id, other.id, 'other'),
        self: await w.appraiser(activity.id, object.id, target.id, 'self'),
        target,
      });
    }
    await w.transition(activity.id, 'enable');
    // 一个评价者在一个活动内只有一个作答链接（E3-R20）
    const customerToken = await w.token(activity.id, customer.id);
    const otherToken = await w.token(activity.id, other.id);
    const tasks = await w.ok<{ tasks: { relationId: string }[] }>(w.link(customerToken)('GET', ''));
    expect(tasks.tasks.map((t) => t.relationId).sort()).toEqual(objects.map((o) => o.customer.id).sort());
    for (const o of objects) {
      expect(((await w.answer(customerToken, o.customer.id, q, ['v4', 'v4'])) as Response).status).toBe(200);
      expect(((await w.answer(otherToken, o.other.id, q, ['v3', 'v5'])) as Response).status).toBe(200);
      const selfToken = await w.token(activity.id, o.target.id);
      expect(((await w.answer(selfToken, o.self.id, q, ['v5', 'v5'])) as Response).status).toBe(200);
    }
    // 活动停用前不计分；停用后各对象都有他评分
    expect(await w.scores(activity.id, objects[0]!.object.id)).toEqual([]);
    await w.transition(activity.id, 'disable');
    for (const o of objects) {
      const rows = await w.scores(activity.id, o.object.id);
      expect(overall(rows, 'other')).toBeCloseTo(4, 6);
      expect(overall(rows, 'self')).toBeCloseTo(5, 6);
    }
    // 停用后链接不再接受作答
    const late = await w.link(customerToken)('PUT', `/tasks/${objects[0]!.customer.id}/questionnaires/${q.id}`, {
      ifMatch: 0,
      body: { answers: [] },
    });
    expect(late.status).toBe(409);
  });

  it('提交后不能再改答卷；答卷未答全不能提交', async () => {
    const w = await world360(testDb().db, 'i11b');
    const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, customer: 1 }));
    const activity = await w.activity();
    const object = await w.object(activity.id, (await w.person('对象')).id, [q.id]);
    const rater = await w.person('评价者');
    const relation = await w.appraiser(activity.id, object.id, rater.id, 'customer');
    await w.transition(activity.id, 'enable');
    const token = await w.token(activity.id, rater.id);
    const call = w.link(token);
    const partial = await w.ok<{ revision: number }>(
      call('PUT', `/tasks/${relation.id}/questionnaires/${q.id}`, {
        ifMatch: 0,
        body: { answers: [{ itemId: q.questions[0]!.id, optionId: q.scales[0]!.options[0]!.id }] },
      }),
    );
    const incomplete = await call('POST', `/tasks/${relation.id}/questionnaires/${q.id}/submit`, {
      ifMatch: partial.revision,
    });
    expect(incomplete.status).toBe(400);
    const stale = await call('PUT', `/tasks/${relation.id}/questionnaires/${q.id}`, {
      ifMatch: 0,
      body: { answers: [] },
    });
    expect(stale.status).toBe(409);
    const options = q.scales[0]!.options;
    const full = q.questions.map((question) => ({ itemId: question.id, optionId: options[4]!.id }));
    const complete = await w.ok<{ revision: number }>(
      call('PUT', `/tasks/${relation.id}/questionnaires/${q.id}`, {
        ifMatch: partial.revision,
        body: { answers: full },
      }),
    );
    const submitted = await w.ok<{ revision: number; status: string }>(
      call('POST', `/tasks/${relation.id}/questionnaires/${q.id}/submit`, { ifMatch: complete.revision }),
    );
    expect(submitted.status).toBe('submitted');
    const before = await w.ok<unknown>(call('GET', `/tasks/${relation.id}/questionnaires/${q.id}`));
    const edit = await call('PUT', `/tasks/${relation.id}/questionnaires/${q.id}`, {
      ifMatch: submitted.revision,
      body: { answers: full.map((a) => ({ ...a, optionId: options[0]!.id })) },
    });
    expect(edit.status).toBe(409);
    expect(await w.ok<unknown>(call('GET', `/tasks/${relation.id}/questionnaires/${q.id}`))).toEqual(before);
  });
});
