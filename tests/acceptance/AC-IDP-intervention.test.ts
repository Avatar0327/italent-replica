/**
 * R3-T07 PR-B 流程干预（docs/02_业务建模/28 IDP-R16；Q-M0-115 ⑥ 只读结论 🟡；PR 描述 K-19 / K-42～K-45）：
 * 催办、开启下个阶段（不处理进行中的 0 / 结束当前阶段并开启 1）、终止。批量逐条回执；revision 不一致的条目 409。
 * 负例前后比对不变。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, planWorld, type PlanView, type Receipt } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

const items = (...plans: PlanView[]) => plans.map((p) => ({ id: p.id, revision: p.revision }));

describe('催办', () => {
  it('通知当前待办人；30 分钟内再催 409；未开始的计划 409', async () => {
    const w = await planWorld(testDb().db, 'idp-urge');
    const plan = await w.startedPlan();
    const idle = await w.createPlan({ name: '未开始' });
    const first = await w.ok<{ receipts: Receipt[] }>(await w.intervene('urge', { items: items(plan, idle) }));
    expect(first.receipts).toEqual([
      expect.objectContaining({ id: plan.id, status: 200, outcome: 'urged' }),
      expect.objectContaining({ id: idle.id, status: 409, code: 'IDP_NO_RUNNING_STAGE' }),
    ]);
    const instance = await w.instanceOf(await w.readPlan(plan.id), 1);
    expect(instance.logs.filter((l) => l.event === 'urge')).toHaveLength(1);
    const again = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('urge', { items: items(await w.readPlan(plan.id)) }),
    );
    expect(again.receipts[0]).toMatchObject({ status: 409, code: 'APPROVAL_URGE_TOO_FREQUENT' });
  });
});

describe('开启下个阶段', () => {
  it('有进行中阶段：不处理（skipRunning）跳过；结束当前阶段（endRunning）后开启下一阶段，原实例作废', async () => {
    const w = await planWorld(testDb().db, 'idp-next');
    let plan = await w.startedPlan();
    const skipped = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('start-next', { items: items(plan), runningMode: 'skipRunning' }),
    );
    expect(skipped.receipts[0]).toMatchObject({ status: 200, outcome: 'skipped' });
    expect((await w.readPlan(plan.id)).stages.map((s) => s.status)).toEqual(['running', 'pending', 'pending']);

    plan = await w.readPlan(plan.id);
    const firstInstance = plan.stages[0]!.approvalInstanceId!;
    const ended = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('start-next', { items: items(plan), runningMode: 'endRunning' }),
    );
    expect(ended.receipts[0]).toMatchObject({ status: 200, outcome: 'opened' });
    plan = await w.readPlan(plan.id);
    expect(plan.stages.map((s) => s.status)).toEqual(['ended', 'running', 'pending']);
    expect((await w.detail(firstInstance)).status).toBe('cancelled');
    expect(plan.currentStageName).toBe('中期回顾');
  });

  it('最后一个阶段之后：该条 409 IDP_NO_NEXT_STAGE；revision 不一致的条目 409，其余照常', async () => {
    const w = await planWorld(testDb().db, 'idp-next-last');
    let plan = await w.startedPlan();
    for (let i = 0; i < 2; i++) {
      await w.ok(await w.intervene('start-next', { items: items(plan), runningMode: 'endRunning' }));
      plan = await w.readPlan(plan.id);
    }
    expect(plan.stages.map((s) => s.status)).toEqual(['ended', 'ended', 'running']);
    const other = await w.startedPlan({ name: '另一个计划' });
    const result = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('start-next', {
        items: [
          { id: plan.id, revision: plan.revision },
          { id: other.id, revision: other.revision + 9 },
        ],
        runningMode: 'endRunning',
      }),
    );
    expect(result.receipts).toEqual([
      expect.objectContaining({ id: plan.id, status: 409, code: 'IDP_NO_NEXT_STAGE' }),
      expect.objectContaining({ id: other.id, status: 409, code: 'REVISION_CONFLICT' }),
    ]);
    expect((await w.readPlan(plan.id)).stages[2]!.status).toBe('running');
    expect((await w.readPlan(other.id)).revision).toBe(other.revision);
  });
});

describe('终止', () => {
  it('进行中 → 已终止：审批实例作废、待办消失、执行人不能再写；再次终止 409', async () => {
    const w = await planWorld(testDb().db, 'idp-terminate');
    const plan = await w.startedPlan();
    const instanceId = plan.stages[0]!.approvalInstanceId!;
    const result = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('terminate', { items: items(plan), reason: '人员离岗暂停培养' }),
    );
    expect(result.receipts[0]).toMatchObject({ status: 200, outcome: 'terminated' });
    const after = await w.readPlan(plan.id);
    expect(after.status).toBe('terminated');
    expect((await w.detail(instanceId)).status).toBe('cancelled');
    expect((await w.todos(w.employee.userId)).items.filter((t) => t.instanceId === instanceId)).toEqual([]);
    const write = await w.execute(w.employee.userId, 'POST', `/plans/${plan.id}/goals`, {
      moduleId: w.goalModule.id,
      name: '终止后不能写',
    });
    expect(write.status).toBe(403);
    const again = await w.ok<{ receipts: Receipt[] }>(await w.intervene('terminate', { items: items(after) }));
    expect(again.receipts[0]).toMatchObject({ status: 409, code: 'IDP_PLAN_NOT_ACTIVE' });
    const next = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('start-next', { items: items(after), runningMode: 'skipRunning' }),
    );
    expect(next.receipts[0]).toMatchObject({ status: 409, code: 'IDP_PLAN_NOT_ACTIVE' });
  });

  it('批量超过上限 400', async () => {
    const w = await planWorld(testDb().db, 'idp-terminate-limit');
    const many = Array.from({ length: 101 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      revision: 1,
    }));
    expect((await errorOf(await w.intervene('terminate', { items: many }))).status).toBe(400);
  });
});
