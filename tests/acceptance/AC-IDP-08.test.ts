/**
 * AC-IDP-08（docs/02_业务建模/28 §5；IDP-R3 开启失败需 HR 查明后手动开启；DEC-052 失败记 failed / 次数 / 原因；
 * PR 描述 K-33）：子流程审批流找不到待办人 → 当天凌晨 2 点开启失败，标记失败；同日、次日调度不自动重试；
 * HR 查明（补上账号绑定）后手动开启成功。
 */
import { permissionUserPersonLinks, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type Approvals, planWorld, type Receipt } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

const stages = (a: Approvals) => [
  {
    name: '制定计划',
    category: 'plan',
    approvalType: 'idp_plan',
    approvalProcessId: a.plan,
    startMode: 'auto',
    startTimeType: 'relative',
    referencePoint: 'plan_start',
    startFrom: 'same_day',
  },
  {
    name: '中期回顾',
    category: 'review',
    approvalType: 'idp_mid_review',
    approvalProcessId: a.mid,
    startMode: 'manual',
  },
];

describe('AC-IDP-08 开启失败与手动开启', () => {
  it('员工没有可用账号：到点开启失败并记原因与次数；不自动重试；补绑定后 HR 手动开启', async () => {
    const w = await planWorld(testDb().db, 'idp-ac08', { stages });
    const unbind = () =>
      withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`DELETE FROM permission_user_person_links WHERE employee_id=${w.employee.employeeId}::uuid`),
      );
    await unbind();
    let plan = await w.startedPlan({ startDate: '2026-03-10' });
    expect(plan.stages[0]).toMatchObject({ status: 'pending', dueDate: '2026-03-10' });

    // 上海 3-10 02:00
    const run = await w.runScheduler('2026-03-09T18:00:00.000Z');
    expect(run.runs[0]).toMatchObject({ opened: [], failed: [plan.stages[0]!.id] });
    plan = await w.readPlan(plan.id);
    expect(plan.stages[0]).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      failureReason: 'APPROVAL_FIRST_NODE_EMPTY',
      approvalInstanceId: null,
    });

    // 同日与次日的调度都不自动重试
    await w.runScheduler('2026-03-09T20:00:00.000Z');
    await w.runScheduler('2026-03-10T18:00:00.000Z');
    expect((await w.readPlan(plan.id)).stages[0]).toMatchObject({ status: 'failed', attemptCount: 1 });

    // 未查明前手动开启：同样失败，次数 + 1
    let receipts = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('start-next', {
        items: [{ id: plan.id, revision: plan.revision }],
        runningMode: 'skipRunning',
      }),
    );
    expect(receipts.receipts[0]).toMatchObject({ status: 409, outcome: 'failed', code: 'APPROVAL_FIRST_NODE_EMPTY' });
    plan = await w.readPlan(plan.id);
    expect(plan.stages[0]).toMatchObject({ status: 'failed', attemptCount: 2 });

    // 查明后：补上账号绑定，手动开启成功
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx
        .insert(permissionUserPersonLinks)
        .values({ tenantId: w.tenant.id, userId: w.employee.userId, employeeId: w.employee.employeeId }),
    );
    receipts = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('start-next', {
        items: [{ id: plan.id, revision: plan.revision }],
        runningMode: 'skipRunning',
      }),
    );
    expect(receipts.receipts[0]).toMatchObject({ status: 200, outcome: 'opened' });
    plan = await w.readPlan(plan.id);
    expect(plan.stages[0]).toMatchObject({ status: 'running', attemptCount: 3, failureReason: null });
    expect((await w.pendingTask(plan, 1, w.employee.userId)).instance.currentNodeKey).toBe('set_goals');
  });
});
