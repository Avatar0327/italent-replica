/**
 * AC-IDP-01（docs/02_业务建模/28 §5；IDP-R2 / R3 / R4；DEC-296⑤ 凌晨 2 点、DEC-056 租户时区、DEC-052 幂等）：
 * 子流程 2 设为“上一阶段结束后 7 天自动开启”，阶段 1 于 9-1 结束 → 9-8 凌晨 2 点（租户时区）开启阶段 2；
 * 9-1～9-8 当前阶段显示“努力提升中”。规格写“零点”，按 DEC-296⑤ 为 02:00（PR 描述 K-05）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type Approvals, planWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

const stages = (a: Approvals) => [
  { name: '制定计划', category: 'plan', approvalType: 'idp_plan', approvalProcessId: a.plan, startMode: 'auto' },
  {
    name: '中期回顾',
    category: 'review',
    approvalType: 'idp_mid_review',
    approvalProcessId: a.mid,
    startMode: 'auto',
    startTimeType: 'relative',
    referencePoint: 'previous_end',
    startFrom: 'after',
    days: 7,
  },
  {
    name: '期末回顾',
    category: 'evaluation',
    approvalType: 'idp_final_review',
    approvalProcessId: a.final,
    startMode: 'manual',
  },
];

describe('AC-IDP-01 上一阶段结束后 7 天的凌晨 2 点自动开启', () => {
  it('阶段 1 于 9-1 结束：空档期显示“努力提升中”，9-8 凌晨 2 点前不开启，到点开启且重复运行幂等', async () => {
    const w = await planWorld(testDb().db, 'idp-ac01', { stages });
    w.setNow('2026-08-25T04:00:00.000Z');
    let plan = await w.startedPlan();
    expect(plan.status).toBe('running');
    // 第一段“自动、无规则”= 计划开始即开启（K-06）
    expect(plan.stages.map((s) => s.status)).toEqual(['running', 'pending', 'pending']);
    expect(plan.currentStageName).toBe('制定计划');

    w.setNow('2026-09-01T03:00:00.000Z'); // 上海 9-1 11:00
    await w.submit(plan, 1, w.employee.userId);
    plan = await w.submit(plan, 1, w.manager.userId);
    expect(plan.stages[0]).toMatchObject({ status: 'ended', endedOn: '2026-09-01' });
    expect(plan.stages[1]).toMatchObject({ status: 'pending', dueDate: '2026-09-08' });
    expect(plan.currentStageName).toBe('努力提升中');

    w.setNow('2026-09-05T03:00:00.000Z');
    await w.runScheduler('2026-09-05T03:00:00.000Z');
    expect((await w.readPlan(plan.id)).currentStageName).toBe('努力提升中');

    // 上海 9-8 01:59：还没到凌晨 2 点
    await w.runScheduler('2026-09-07T17:59:00.000Z');
    expect((await w.readPlan(plan.id)).stages[1]!.status).toBe('pending');

    // 上海 9-8 02:00：开启
    const run = await w.runScheduler('2026-09-07T18:00:00.000Z');
    expect(run.runs[0]).toMatchObject({ businessDate: '2026-09-08', opened: [plan.stages[1]!.id], failed: [] });
    const opened = await w.readPlan(plan.id);
    expect(opened.stages[1]).toMatchObject({ status: 'running', attemptCount: 1 });
    expect(opened.currentStageName).toBe('中期回顾');
    const instanceId = opened.stages[1]!.approvalInstanceId;
    const task = await w.pendingTask(opened, 2, w.employee.userId);
    expect(task.instance.currentNodeKey).toBe('employee_mid');

    // 同一业务日重复运行：不再开启、不重复建实例（幂等键 = 阶段 + 业务日）
    const again = await w.runScheduler('2026-09-07T19:00:00.000Z');
    expect(again.runs[0]!.opened).toEqual([]);
    expect((await w.readPlan(plan.id)).stages[1]!.approvalInstanceId).toBe(instanceId);
  });

  it('租户时区判定业务日：UTC 已是 9-8、上海仍是 9-8 之前的不开启', async () => {
    const w = await planWorld(testDb().db, 'idp-ac01-tz', { stages });
    w.setNow('2026-08-25T04:00:00.000Z');
    let plan = await w.startedPlan();
    w.setNow('2026-09-01T03:00:00.000Z');
    await w.submit(plan, 1, w.employee.userId);
    plan = await w.submit(plan, 1, w.manager.userId);
    // UTC 9-7 15:00 = 上海 9-7 23:00
    await w.runScheduler('2026-09-07T15:00:00.000Z');
    expect((await w.readPlan(plan.id)).stages[1]!.status).toBe('pending');
  });
});
