/**
 * AC-F476-15（P8 IDP 片）：同一计划多个阶段，各阶段办理份互相独立，按实例上下文选对份并保存非空真实详情。
 * 本片覆盖：多阶段选择（缺省上下文 / ?instanceId= 指定）、非本计划实例 404、阶段办理份内容各自独立。
 * 留给 P9：交接重新发起、他人后续勾选对办理份的影响（本片只提供可复用的阶段上下文与稳定读接口）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';
import {
  copiesOfPlan,
  copyGoalNames,
  expectRealDetail,
  GOAL_A,
  GOAL_B,
  goalNames,
  handledThenModified,
  seen,
  SUMMARY,
} from './AC-F476-idp-support.js';

const testDb = useTestDb();
const items = (plan: PlanView) => [{ id: plan.id, revision: plan.revision }];

/** 阶段 1 办完（员工提交、指导人同意），开启中期回顾；员工在阶段 2 改目标、填回顾后提交。 */
async function twoStagesHandled(w: PlanWorld) {
  const { plan, goalId } = await handledThenModified(w);
  await w.submit(plan, 1, w.manager.userId);
  let current = await w.readPlan(plan.id);
  w.setNow('2026-03-02T04:00:00.000Z'); // 阶段 2 的办理晚于阶段 1，跨阶段选择按办理时间比较
  await w.ok(await w.intervene('start-next', { items: items(current), runningMode: 'skipRunning' }));
  current = await w.readPlan(plan.id);
  await w.ok(
    await w.execute(w.employee.userId, 'PATCH', `/plans/${plan.id}/goals/${goalId}`, { name: 'ZZ_中期阶段目标' }),
  );
  await w.fillReview(current, { summary: SUMMARY });
  current = await w.submit(await w.readPlan(plan.id), 2, w.employee.userId);
  return { plan: current, goalId };
}

describe('AC-F476-15 IDP：同一计划多阶段，选对实例', () => {
  it('各阶段办理份独立保存非空真实详情：阶段 1 是办理时目标，阶段 2 带中期总结与阶段内目标', async () => {
    const w = await planWorld(testDb().db, 'f476-idp-15-copies');
    const { plan } = await twoStagesHandled(w);
    const copies = await copiesOfPlan(w, plan.id);
    const stage1 = copies.filter((c) => c.business_id === plan.stages[0]!.id);
    const stage2 = copies.filter((c) => c.business_id === plan.stages[1]!.id);
    expect(stage1.length).toBeGreaterThan(0);
    expect(stage2).toHaveLength(1);
    for (const copy of [...stage1, ...stage2]) expectRealDetail(copy);
    expect(copyGoalNames(stage1[0])).toEqual([GOAL_A]);
    expect(stage2[0]!.text).toContain(SUMMARY);
    expect(stage2[0]!.text).toContain('ZZ_中期阶段目标');
  });

  it('缺省上下文读最近办理的阶段；?instanceId= 指定阶段 1 读阶段 1 办理份；两者互不串', async () => {
    const w = await planWorld(testDb().db, 'f476-idp-15-select');
    const { plan } = await twoStagesHandled(w);
    const [one, two] = [plan.stages[0]!.approvalInstanceId!, plan.stages[1]!.approvalInstanceId!];

    const latest = await seen(w, w.employee.userId, plan.id);
    expect(latest.contentView).toMatchObject({ mode: 'frozen', instanceId: two });
    expect(goalNames(latest)).toEqual(['ZZ_中期阶段目标']);
    expect(latest.reviews?.map((r) => r.summary)).toEqual([SUMMARY]);

    const stage1 = await seen(w, w.employee.userId, plan.id, `?instanceId=${one}`);
    expect(stage1.contentView).toMatchObject({ mode: 'frozen', instanceId: one });
    expect(goalNames(stage1)).toEqual([GOAL_A]);
    expect(stage1.reviews ?? []).toEqual([]);
  });

  it('?instanceId= 不是本计划阶段的实例（别的计划 / 不存在）→ 404；不泄露内容', async () => {
    const w = await planWorld(testDb().db, 'f476-idp-15-foreign');
    const { plan } = await handledThenModified(w);
    const other = await handledThenModified(w);
    const foreign = other.plan.stages[0]!.approvalInstanceId!;
    for (const id of [foreign, '00000000-0000-4000-8000-000000000000']) {
      const response = await w.realHttp(w.employee.userId, 'GET', `/api/tenant/idp/plans/${plan.id}?instanceId=${id}`);
      expect(response.status).toBe(404);
    }
    const bad = await w.realHttp(w.employee.userId, 'GET', `/api/tenant/idp/plans/${plan.id}?instanceId=not-a-uuid`);
    expect([400, 404]).toContain(bad.status);
    expect(goalNames(await seen(w, w.manager.userId, plan.id))).toEqual([GOAL_B]);
  });
});
