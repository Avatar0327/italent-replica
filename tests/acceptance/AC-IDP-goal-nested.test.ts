/**
 * R3-T07 PR-B 第 2 轮 P2-3：目标的嵌套 tasks / reviews 按 IDP.IdpGoal.tasks / reviews 的字段查看权裁剪，不能投影完目标
 * 字段再挂回去；子对象（任务 / 目标回顾）自身的查看权仍要同时具备。计划详情与返回计划详情的写入 / 重放响应同一出口。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, type PlanView } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

describe('P2-3：目标嵌套字段的字段权限', () => {
  it('隐藏 IdpGoal.tasks / reviews：详情、PATCH 响应与同键重放都不返回任务与目标回顾', async () => {
    const w = await planWorld(testDb().db, 'idp-goal-nested');
    const pw = await permissionWorldOf(w);
    let plan = await w.startedPlan();
    plan = await w.addGoal(plan, w.employee.userId, { name: '嵌套目标' });
    const goal = plan.goals!.find((g) => g.name === '嵌套目标')!;
    await w.ok(
      await w.execute(w.employee.userId, 'POST', `/plans/${plan.id}/goals/${goal.id}/tasks`, {
        name: '隐藏的任务说明',
        description: '任务细节不应出现',
      }),
      201,
    );
    await w.ok(
      await w.execute(w.employee.userId, 'PUT', `/plans/${plan.id}/goals/${goal.id}/review`, {
        progress: 40,
        outcome: '隐藏的回顾成果',
      }),
    );
    const leaks = ['隐藏的任务说明', '任务细节不应出现', '隐藏的回顾成果'];
    const hr = await idpOperator(pw, { orgId: w.dept, hidden: { goal: ['tasks', 'reviews'] } });
    const detail = await hr.request('GET', `/plans/${plan.id}`);
    const text = await detail.text();
    expect(detail.status, text).toBe(200);
    const shown = (JSON.parse(text) as PlanView).goals!.find((g) => g.id === goal.id)!;
    expect(shown).toMatchObject({ name: '嵌套目标' });
    expect(shown).not.toHaveProperty('tasks');
    expect(shown).not.toHaveProperty('reviews');
    for (const leak of leaks) expect(text).not.toContain(leak);

    const current = await w.readPlan(plan.id);
    const options = { ifMatch: current.revision, idempotencyKey: 'nested-patch', body: { name: '改名后的计划' } };
    for (const round of ['first', 'replay']) {
      const response = await hr.request('PATCH', `/plans/${plan.id}`, options);
      const body = await response.text();
      expect(response.status, `${round} ${body}`).toBe(200);
      for (const leak of leaks) expect(body, round).not.toContain(leak);
    }

    // 对照：字段可见时照常返回
    const full = await idpOperator(pw, { orgId: w.dept });
    const visible = await (await full.request('GET', `/plans/${plan.id}`)).text();
    for (const leak of leaks) expect(visible).toContain(leak);
  });
});
