/**
 * AC-IDP-06（docs/02_业务建模/28 §5；IDP-R15 统一下发任务须使用同一模板；PR 描述 K-46）：给使用两个不同模板的计划
 * 统一下发任务 → 拒绝（409 IDP_TASK_TEMPLATE_MISMATCH，提示分开下发），一条任务都不生成；同一模板的计划整体下发成功，
 * 任务挂在各计划由该通用目标生成的目标下。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { TemplateView } from './AC-IDP-support.js';
import { errorOf, otherTutor, planWorld, type PlanView } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

const taskBody = { name: '完成一次跨部门项目复盘', description: '与产品、运营共同复盘', endDate: '2026-06-30' };

describe('AC-IDP-06 统一下发任务', () => {
  it('两个不同模板的计划：409，提示分开下发，前后都没有任务', async () => {
    const w = await planWorld(testDb().db, 'idp-ac06');
    const copied = await w.ok<TemplateView>(
      await w.http(w.hrUser, 'POST', `/api/tenant/idp/templates/${w.template.id}/copy`, {
        ifMatch: 0,
        body: { name: '复制的发展计划模板' },
      }),
      201,
    );
    await w.ok(
      await w.http(w.hrUser, 'POST', `/api/tenant/idp/templates/${copied.id}/publish`, { ifMatch: copied.revision }),
    );
    const a = await w.createPlan();
    const b = await w.createPlan({ templateId: copied.id, ...otherTutor(w) }, w.hrUser, w.outsider);
    const response = await w.intervene('tasks/issue', {
      commonGoalId: w.firstCommonGoal.id,
      plans: [a, b].map((p) => ({ id: p.id, revision: p.revision })),
      task: taskBody,
    });
    expect(await errorOf(response)).toMatchObject({ status: 409, reason: 'IDP_TASK_TEMPLATE_MISMATCH' });
    for (const plan of [a, b]) {
      const after = await w.readPlan(plan.id);
      expect(after.goals!.flatMap((g) => g.tasks)).toEqual([]);
      expect(after.revision).toBe(plan.revision);
    }
  });

  it('同一模板的计划：整体下发，任务挂在通用目标生成的目标下', async () => {
    const w = await planWorld(testDb().db, 'idp-ac06-same');
    const plans: PlanView[] = [
      await w.createPlan(),
      await w.createPlan({ name: '丙的计划', ...otherTutor(w) }, w.hrUser, w.outsider),
    ];
    const response = await w.intervene('tasks/issue', {
      commonGoalId: w.firstCommonGoal.id,
      plans: plans.map((p) => ({ id: p.id, revision: p.revision })),
      task: taskBody,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    for (const plan of plans) {
      const goal = (await w.readPlan(plan.id)).goals!.find((g) => g.commonGoalId === w.firstCommonGoal.id)!;
      expect(goal.tasks.map((t) => [t.name, t.description, t.endDate])).toEqual([
        [taskBody.name, taskBody.description, taskBody.endDate],
      ]);
    }
  });

  it('任一计划 revision 不一致：整体 409，不部分生效', async () => {
    const w = await planWorld(testDb().db, 'idp-ac06-rev');
    const a = await w.createPlan();
    const b = await w.createPlan({ name: '丙的计划', ...otherTutor(w) }, w.hrUser, w.outsider);
    const response = await w.intervene('tasks/issue', {
      commonGoalId: w.firstCommonGoal.id,
      plans: [
        { id: a.id, revision: a.revision },
        { id: b.id, revision: b.revision + 5 },
      ],
      task: taskBody,
    });
    expect(response.status).toBe(409);
    expect((await w.readPlan(a.id)).goals!.flatMap((g) => g.tasks)).toEqual([]);
  });
});
