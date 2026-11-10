/**
 * AC-F476-10（P8 IDP，第 4 轮审查返工 自检表补出的泄漏列）：办理份 snapshot 的审批类型 / 标题。
 * 子流程的审批类型（idp_sub_processes.approval_type）由 PATCH /idp/processes/:id 维护，只锁流程、不锁计划；没有节点配置的
 * 已引用子流程可以连同审批流程一起换类型（K-28 只拦有节点配置的段）。旧实现在办理时另起一条语句读子流程现值，
 * 与扩展内容不在同一快照，也和实例发起时冻结的类型对不上。办理份的审批类型必须是被办理实例的类型（发起后不再改）。
 * 顺序执行即可复现，PGlite 与真 PG 都跑。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { IDP, planWorld, type PlanView } from './AC-IDP-plan-support.js';
import type { ProcessView } from './AC-IDP-support.js';

const testDb = useTestDb();
const items = (plan: PlanView) => [{ id: plan.id, revision: plan.revision }];

describe('AC-F476-10 IDP：办理份的审批类型取被办理实例的类型', () => {
  it('期末回顾进行中把子流程改成“中期回顾”类型后办理：办理份仍是实例的期末回顾类型与标题', async () => {
    const w = await planWorld(testDb().db, 'f476-idp-10-type');
    let plan = await w.startedPlan();
    for (let i = 0; i < 2; i++) {
      await w.ok(await w.intervene('start-next', { items: items(plan), runningMode: 'endRunning' }));
      plan = await w.readPlan(plan.id);
    }
    expect(plan.stages.map((s) => s.status)).toEqual(['terminated', 'terminated', 'running']);
    const { instance, task } = await w.pendingTask(plan, 3, w.employee.userId);

    // 期末回顾段没有节点配置：可换审批流程与类型（真实接口，只锁流程）
    const latest = await w.ok<ProcessView>(await w.http(w.hrUser, 'GET', `${IDP}/processes/${w.process.id}`));
    const input = latest.subProcesses.map(({ ruleText: _ruleText, ...rest }) => rest);
    const moved = input.map((s, i) =>
      i === 2 ? { ...s, approvalType: 'idp_mid_review', approvalProcessId: w.approvals.mid } : s,
    );
    await w.ok(
      await w.http(w.hrUser, 'PATCH', `${IDP}/processes/${w.process.id}`, {
        ifMatch: latest.revision,
        body: { subProcesses: moved },
      }),
    );

    const response = await w.taskAction(w.employee.userId, task.id, 'approve', instance.revision);
    expect(response.status, await response.clone().text()).toBe(200);
    const rows = await withTenant(w.db, w.tenant.id, async (tx) =>
      tx.execute(sql`SELECT i.approval_type AS "instanceType", i.title AS "instanceTitle",
          c.content->'snapshot'->>'approvalType' AS "copyType", c.content->'snapshot'->>'title' AS "copyTitle"
        FROM approval_handling_contents c
        JOIN approval_instances i ON i.tenant_id = c.tenant_id AND i.id = c.instance_id
        WHERE c.instance_id = ${instance.id}::uuid`),
    );
    const copies = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as Record<string, string>[];
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) {
      expect(copy.instanceType).toBe('idp_final_review');
      expect({ type: copy.copyType, title: copy.copyTitle }).toEqual({
        type: copy.instanceType,
        title: copy.instanceTitle,
      });
    }
  });
});
