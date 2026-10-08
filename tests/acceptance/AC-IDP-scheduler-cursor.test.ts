/**
 * R3-T07 PR-B 第 2 轮 P2-9：调度不能先截断候选再判断能否开启（DEC-052 可重复执行；IDP-R3）。
 * 排在前面但开不了的计划（未到期、仍有运行中阶段、前序手动 / 失败、缺参照日期、一直被锁）不能挡住后面已到期的计划：
 * limit 是一次运行最多尝试开启的阶段数，候选按游标往后推进。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runIdpAutoStarts } from '../../apps/api/src/modules/idp/scheduler.js';
import { type Approvals, planWorld, type PlanView } from './AC-IDP-plan-support.js';
import { cmd } from './support/tenant-api.js';

const testDb = useTestDb();

/** 第一段：计划开始日当天自动开启（有规则 → 由调度开启）；其余同缺省。 */
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

describe('P2-9：调度候选按游标推进', () => {
  it('limit=1：排在前面的计划未到期，后面已到期的计划一次运行即开启', async () => {
    const w = await planWorld(testDb().db, 'idp-sched-cursor', { stages });
    const plans: PlanView[] = [];
    // 建足够多的计划，保证“未到期”的计划 id 排在“已到期”之前的情形出现
    for (let i = 0; i < 4; i++) {
      const view = await w.createPlan({ name: `未到期 ${i}`, startDate: '2026-12-01' });
      plans.push(await w.start(view));
    }
    const due = await w.start(await w.createPlan({ name: '已到期', startDate: '2026-01-01' }));
    const notDue = plans.filter((p) => p.id < due.id);
    // 极少数情况下随机 id 全部大于已到期的计划：重建直到满足前提
    while (notDue.length === 0) {
      const view = await w.start(await w.createPlan({ name: '未到期补充', startDate: '2026-12-01' }));
      if (view.id < due.id) notDue.push(view);
    }
    const result = await runIdpAutoStarts(
      w.db,
      cmd(),
      { tenantId: w.tenant.id, limit: 1 },
      { clock: () => new Date('2026-03-01T19:00:00.000Z') },
    );
    expect(result.runs[0]!.opened).toEqual([due.stages[0]!.id]);
    expect((await w.readPlan(due.id)).stages[0]!.status).toBe('running');
    for (const plan of notDue) expect((await w.readPlan(plan.id)).stages[0]!.status).toBe('pending');
  });
});
