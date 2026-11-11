/**
 * AC-F476-08（P8 IDP，第 1 轮审查返工 P2-3）：审批中心入口 GET /approval/instances/:id 与计划详情读到同一份办理时内容；
 * 办理份缺 IDP 扩展时两个入口都拒绝（503 APPROVAL_HANDLING_CONTENT_MISSING，不回退现值，DEC-807）。
 * 第 2 轮返工：计划被正常删除后，完整的办理份照样能在审批中心读到（呈现不依赖当前计划存在）。
 * 断言只看业务内容（响应里出现哪些合成名称），不依赖响应字段形状。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { IDP, type PlanWorld, planWorld } from './AC-IDP-plan-support.js';
import { ANALYSIS_A, GOAL_A, GOAL_B, handledThenModified, seen, TASK_A, TASK_B } from './AC-F476-idp-support.js';

const testDb = useTestDb();
const APPROVAL = '/api/tenant/approval';

const centerText = async (w: PlanWorld, user: string, instanceId: string) => {
  const response = await w.request(user, 'GET', `${APPROVAL}/instances/${instanceId}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return JSON.stringify(await response.json());
};

/** 去掉某人办理份里的 IDP 扩展（模拟备份恢复丢了扩展：只留通用快照）。F-476-11 同款：临时关闭只读守卫的 USER 触发器。 */
async function stripExt(w: PlanWorld, user: string) {
  await w.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${w.tenant.id}, true)`);
    await tx.execute(sql`ALTER TABLE approval_handling_contents DISABLE TRIGGER USER`);
    await tx.execute(
      sql`UPDATE approval_handling_contents SET content = content - 'ext' WHERE actor_user_id = ${user}::uuid`,
    );
    await tx.execute(sql`ALTER TABLE approval_handling_contents ENABLE TRIGGER USER`);
  });
}

describe('AC-F476-08 IDP：审批中心入口接入办理时内容', () => {
  it('员工办理后指导人改了内容：审批中心详情与计划详情都读到办理时的 A，不含现值 B', async () => {
    const w = await planWorld(testDb().db, 'f476-idp-08-center');
    const { plan, instanceId } = await handledThenModified(w);

    const center = await centerText(w, w.employee.userId, instanceId);
    for (const kept of [GOAL_A, TASK_A, ANALYSIS_A]) expect(center, kept).toContain(kept);
    for (const leaked of [GOAL_B, TASK_B]) expect(center, leaked).not.toContain(leaked);

    // 同一夹具的第二个入口：计划详情读到同样的目标 / 任务 / 综述
    const planText = JSON.stringify(await seen(w, w.employee.userId, plan.id));
    for (const kept of [GOAL_A, TASK_A, ANALYSIS_A]) expect(planText, kept).toContain(kept);
    expect(planText).not.toContain(GOAL_B);
  });

  it('办理份缺 IDP 扩展：审批中心与计划详情都 503 APPROVAL_HANDLING_CONTENT_MISSING，不回退现值', async () => {
    const w = await planWorld(testDb().db, 'f476-idp-08-center-missing');
    const { plan, instanceId } = await handledThenModified(w);
    await stripExt(w, w.employee.userId);

    const center = await w.request(w.employee.userId, 'GET', `${APPROVAL}/instances/${instanceId}`);
    expect(center.status, await center.clone().text()).toBe(503);
    expect(JSON.stringify(await center.json())).toContain('APPROVAL_HANDLING_CONTENT_MISSING');

    const viaPlan = await w.realHttp(w.employee.userId, 'GET', `/api/tenant/idp/plans/${plan.id}`);
    expect(viaPlan.status, await viaPlan.clone().text()).toBe(503);

    // 指导人（在办，读现值）不受影响
    expect(await centerText(w, w.manager.userId, instanceId)).not.toContain('APPROVAL_HANDLING_CONTENT_MISSING');
  });

  it('办理 A 后 HR 删除计划：本人打开原审批实例详情仍读到办理时的 A', async () => {
    const w = await planWorld(testDb().db, 'f476-idp-08-center-deleted');
    const { plan, instanceId } = await handledThenModified(w);
    const removed = await w.http(w.hrUser, 'DELETE', `${IDP}/plans/${plan.id}`, { ifMatch: plan.revision });
    expect(removed.status, await removed.clone().text()).toBeLessThan(300);
    expect((await w.realHttp(w.hrUser, 'GET', `${IDP}/plans/${plan.id}`)).status, '计划确已删除').toBe(404);

    const center = await centerText(w, w.employee.userId, instanceId);
    for (const kept of [GOAL_A, TASK_A, ANALYSIS_A]) expect(center, kept).toContain(kept);
    for (const leaked of [GOAL_B, TASK_B]) expect(center, leaked).not.toContain(leaked);
  });
});
