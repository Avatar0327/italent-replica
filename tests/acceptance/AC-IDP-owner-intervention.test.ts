/**
 * DEC-321（PR #115 第 3 轮补充）：计划所有者（建计划的人，K-38 起即审批发起人）可以全量流程干预——催办、跳转、终止——
 * 作为 DEC-092“本人发起”回避的例外；每次干预都写计划的审计记录：操作人、计划、动作、原因。
 * 计划员工本人（不是所有者）干预自己的计划仍按 DEC-092 拒绝。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, planWorld, type PlanView, type PlanWorld, type Receipt } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';

interface InterventionLog {
  actor_user_id: string;
  object_id: string;
  after: { intervention?: string; reason?: string | null } | null;
}

async function interventionLogs(w: PlanWorld, planId: string): Promise<InterventionLog[]> {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT actor_user_id, object_id, after FROM audit_events
      WHERE tenant_id = ${w.tenant.id} AND object_id = ${planId} AND after->>'intervention' IS NOT NULL
      ORDER BY occurred_at, id`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as InterventionLog[];
  });
}

const items = (plan: PlanView) => [{ id: plan.id, revision: plan.revision }];

describe('DEC-321：计划所有者的流程干预', () => {
  it('所有者催办、跳转、终止都成功，各写一条审计（操作人、计划、动作、原因）', async () => {
    const w = await planWorld(testDb().db, 'idp-owner-iv');
    let plan = await w.startedPlan();
    const instance = await w.instanceOf(plan, 1);
    expect(instance.initiatorUserId).toBe(w.hrUser);

    const urged = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('urge', { items: items(plan), reason: '请尽快制定目标' }),
    );
    expect(urged.receipts).toEqual([expect.objectContaining({ status: 200, outcome: 'urged' })]);

    plan = await w.readPlan(plan.id);
    const jumped = await w.http(w.hrUser, 'POST', `${IDP}/plans/${plan.id}/jump`, {
      ifMatch: plan.revision,
      body: { toNodeKey: 'approve_plan', reason: '员工已线下确认目标' },
    });
    expect(jumped.status, await jumped.clone().text()).toBe(200);

    plan = await w.readPlan(plan.id);
    const terminated = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('terminate', { items: items(plan), reason: '员工转岗，计划作废' }),
    );
    expect(terminated.receipts).toEqual([expect.objectContaining({ status: 200, outcome: 'terminated' })]);

    expect(await interventionLogs(w, plan.id)).toEqual([
      expect.objectContaining({
        actor_user_id: w.hrUser,
        object_id: plan.id,
        after: expect.objectContaining({ intervention: 'urge', reason: '请尽快制定目标' }),
      }),
      expect.objectContaining({
        actor_user_id: w.hrUser,
        object_id: plan.id,
        after: expect.objectContaining({ intervention: 'jump', reason: '员工已线下确认目标' }),
      }),
      expect.objectContaining({
        actor_user_id: w.hrUser,
        object_id: plan.id,
        after: expect.objectContaining({ intervention: 'terminate', reason: '员工转岗，计划作废' }),
      }),
    ]);
  });

  it('计划员工本人（非所有者）干预自己的计划：催办 / 终止回执 403，跳转 403，计划与审计不变', async () => {
    const w = await planWorld(testDb().db, 'idp-owner-self');
    const plan = await w.startedPlan();
    const self = w.employee.userId;
    for (const path of ['urge', 'terminate']) {
      const result = await w.ok<{ receipts: Receipt[] }>(
        await w.intervene(path, { items: items(plan), reason: '自己处理' }, self),
      );
      expect(result.receipts, path).toEqual([expect.objectContaining({ status: 403, code: 'IDP_INTERVENE_SELF' })]);
    }
    const jumped = await w.http(self, 'POST', `${IDP}/plans/${plan.id}/jump`, {
      ifMatch: plan.revision,
      body: { toNodeKey: 'approve_plan', reason: '自己跳过' },
    });
    expect(await errorOf(jumped)).toMatchObject({ status: 403 });
    const after = await w.readPlan(plan.id);
    expect(after).toMatchObject({ status: 'running', revision: plan.revision });
    expect(await interventionLogs(w, plan.id)).toEqual([]);
  });
});
