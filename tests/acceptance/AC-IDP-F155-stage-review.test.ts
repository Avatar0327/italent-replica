/**
 * F-155a（DEC-511 UI3补 ④(b)(c)；docs/09_派发/后续任务.md F-155）：
 * - 流程干预“开启下个阶段 · 结束当前阶段”跳过的阶段落为已终止（terminated），正常审批完成仍为已结束（ended）；
 *   已终止算“已过去的阶段”：后续阶段的“上一阶段结束”参照、调度的“前序都已结束”、计划结束判定都把它算进去；
 * - 中期回顾（回顾模块）：保存时总结、改进方法各 ≤1000 字、可以只填一项；提交（同意）当前节点时两项必填。
 * 负例前后比对不变。
 */
import { STAGE_STATUSES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { t } from '../../apps/web/src/idp/messages.js';
import {
  type Approvals,
  planWorld,
  type PlanView,
  type PlanWorld,
  type PlanWorldOptions,
  type Receipt,
} from './AC-IDP-plan-support.js';

const testDb = useTestDb();

const items = (plan: PlanView) => [{ id: plan.id, revision: plan.revision }];

const relative = { startMode: 'auto', startTimeType: 'relative', referencePoint: 'previous_end', startFrom: 'after' };

/** 三段都自动：后两段在上一阶段结束 7 天后开启，用来核对“已终止”是否被当作已过去的阶段。 */
const autoStages = (a: Approvals) => [
  { name: '制定计划', category: 'plan', approvalType: 'idp_plan', approvalProcessId: a.plan, startMode: 'auto' },
  {
    name: '中期回顾',
    category: 'review',
    approvalType: 'idp_mid_review',
    approvalProcessId: a.mid,
    ...relative,
    days: 7,
  },
  {
    name: '期末回顾',
    category: 'evaluation',
    approvalType: 'idp_final_review',
    approvalProcessId: a.final,
    ...relative,
    days: 7,
  },
];

interface ErrorBody {
  readonly error: { readonly code: string; readonly details?: { reason?: string; fields?: string[] } };
}

async function errorBody(response: Response) {
  return { status: response.status, ...((await response.json()) as ErrorBody).error };
}

describe('F-155a 被跳过的阶段为已终止', () => {
  it('结束当前阶段再开启下一阶段：被跳过的阶段已终止；正常完成为已结束；已终止算已过去的阶段', async () => {
    const w = await planWorld(testDb().db, 'idp-f155-skip', { stages: autoStages });
    let plan = await w.startedPlan();
    expect(plan.stages.map((s) => s.status)).toEqual(['running', 'pending', 'pending']);

    w.setNow('2026-03-10T04:00:00.000Z'); // 上海 3-10 12:00
    const skipped = await w.ok<{ receipts: Receipt[] }>(
      await w.intervene('start-next', { items: items(plan), runningMode: 'endRunning' }),
    );
    expect(skipped.receipts[0]).toMatchObject({ status: 200, outcome: 'opened' });
    plan = await w.readPlan(plan.id);
    expect(plan.stages.map((s) => s.status)).toEqual(['terminated', 'running', 'pending']);
    expect(plan.stages[0]).toMatchObject({ endedOn: '2026-03-10' });
    // “上一阶段结束后 7 天”：被终止的阶段也是已过去的阶段，按其结束日推算
    expect(plan.stages[1]!.dueDate).toBe('2026-03-17');
    expect(plan.currentStageName).toBe('中期回顾');

    await w.fillReview(plan);
    await w.submit(plan, 2, w.employee.userId);
    plan = await w.submit(plan, 2, w.manager.userId);
    expect(plan.stages.map((s) => s.status)).toEqual(['terminated', 'ended', 'pending']);
    expect(plan.stages[2]!.dueDate).toBe('2026-03-17');

    // 调度：前序阶段（已终止 + 已结束）都已过去 → 3-17 凌晨 2 点开启第三段
    const run = await w.runScheduler('2026-03-16T18:00:00.000Z');
    expect(run.runs[0]).toMatchObject({ opened: [plan.stages[2]!.id], failed: [] });
    plan = await w.readPlan(plan.id);
    await w.submit(plan, 3, w.employee.userId);
    plan = await w.submit(plan, 3, w.manager.userId);
    // 最后一段结束：已终止的阶段不挡计划结束
    expect(plan).toMatchObject({ status: 'ended', currentStageName: null });
    expect(plan.stages.map((s) => s.status)).toEqual(['terminated', 'ended', 'ended']);
  });
});

async function atMidReview(label: string, options: PlanWorldOptions = {}) {
  const w = await planWorld(testDb().db, label, options);
  return { w, plan: await midReviewPlan(w) };
}

async function midReviewPlan(w: PlanWorld, extra: Record<string, unknown> = {}) {
  let plan = await w.startedPlan(extra);
  await w.submit(plan, 1, w.employee.userId);
  plan = await w.submit(plan, 1, w.manager.userId);
  await w.ok(await w.intervene('start-next', { items: items(plan), runningMode: 'skipRunning' }));
  plan = await w.readPlan(plan.id);
  expect(plan.currentNodeName).toBe('员工中期回顾');
  return plan;
}

describe('F-155a 中期回顾：保存限长、提交必填', () => {
  const contentPath = (w: Awaited<ReturnType<typeof atMidReview>>['w'], plan: PlanView) =>
    `/plans/${plan.id}/modules/${w.reviewModule.id}/content`;

  it('保存：总结 / 改进方法各 ≤1000 字，超长 400 并指出字段；可以只填一项先保存', async () => {
    const { w, plan } = await atMidReview('idp-f155-save');
    const path = contentPath(w, plan);
    const tooLong = await w.execute(w.employee.userId, 'PUT', path, { summary: '长'.repeat(1001), improvement: '短' });
    expect(await errorBody(tooLong)).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      details: { reason: 'IDP_REVIEW_TOO_LONG', fields: ['summary'] },
    });
    const bothLong = await w.execute(w.employee.userId, 'PUT', path, {
      summary: '长'.repeat(1001),
      improvement: '长'.repeat(1001),
    });
    expect(await errorBody(bothLong)).toMatchObject({ details: { fields: ['summary', 'improvement'] } });
    expect((await w.readPlan(plan.id)).reviews).toEqual([]);

    const draft = await w.execute(w.employee.userId, 'PUT', path, { summary: '满'.repeat(1000) });
    expect(draft.status, await draft.clone().text()).toBe(200);
    const saved = await w.readPlan(plan.id);
    expect(saved.reviews).toEqual([
      expect.objectContaining({ stageId: plan.stages[1]!.id, summary: '满'.repeat(1000), improvement: null }),
    ]);
  });

  it('提交：缺总结或改进方法 409 并指出字段，审批实例不动；两项都填后可以提交', async () => {
    const { w, plan } = await atMidReview('idp-f155-submit');
    const before = await w.instanceOf(plan, 2);

    const empty = await w.submitRaw(plan, 2, w.employee.userId);
    expect(await errorBody(empty)).toMatchObject({
      status: 409,
      details: { reason: 'IDP_REVIEW_REQUIRED', fields: ['summary', 'improvement'] },
    });

    // 只保存了总结（空白按未填）：仍缺改进方法
    await w.fillReview(plan, { improvement: '   ' });
    const partial = await w.submitRaw(await w.readPlan(plan.id), 2, w.employee.userId);
    expect(await errorBody(partial)).toMatchObject({
      status: 409,
      details: { reason: 'IDP_REVIEW_REQUIRED', fields: ['improvement'] },
    });
    const unchanged = await w.instanceOf(plan, 2);
    expect(unchanged.revision).toBe(before.revision);
    expect(unchanged.currentNodeKey).toBe('employee_mid');

    await w.fillReview(await w.readPlan(plan.id));
    const submitted = await w.submit(await w.readPlan(plan.id), 2, w.employee.userId);
    expect(submitted.currentNodeName).toBe('指导人中期回顾');
    // 指导人节点没有填写回顾的按钮，不再校验
    const done = await w.submit(submitted, 2, w.manager.userId);
    expect(done.stages[1]!.status).toBe('ended');
  });
});

describe('F-155a 回顾必填只拦“同意”（第 1 轮 P2-1）', () => {
  /** 租户给员工中期回顾节点打开了驳回与不同意（节点开关，DEC-318 K-39 / DEC-144）。 */
  const employeeExits: PlanWorldOptions = {
    nodes: { idp_employee: { actions: { reject: true }, exits: ['approve', 'disagree'] } },
  };

  async function undecided(label: string) {
    const w = await planWorld(testDb().db, label, employeeExits);
    const plan = await midReviewPlan(w);
    const { instance, task } = await w.pendingTask(plan, 2, w.employee.userId);
    const decide = (action: 'approve' | 'disagree' | 'reject') =>
      w.taskAction(w.employee.userId, task.id, action, instance.revision, { comment: '回顾稍后补' });
    return { w, plan, decide };
  }

  it('回顾没填齐时同意：409 IDP_REVIEW_REQUIRED，任务不动', async () => {
    const { w, plan, decide } = await undecided('idp-f155-approve');
    expect(await errorBody(await decide('approve'))).toMatchObject({
      status: 409,
      details: { reason: 'IDP_REVIEW_REQUIRED', fields: ['summary', 'improvement'] },
    });
    expect((await w.instanceOf(plan, 2)).currentNodeKey).toBe('employee_mid');
  });

  it('回顾没填齐时不同意：照常办理，流程沿不同意结束、阶段记开启失败（K-39）', async () => {
    const { w, plan, decide } = await undecided('idp-f155-disagree');
    const disagreed = await decide('disagree');
    expect(disagreed.status, await disagreed.clone().text()).toBe(200);
    expect((await w.readPlan(plan.id)).stages[1]).toMatchObject({
      status: 'failed',
      failureReason: 'APPROVAL_DISAPPROVED',
    });
  });

  it('回顾没填齐时驳回：照常办理，退回发起人（计划所有者）、阶段保持进行中', async () => {
    const { w, plan, decide } = await undecided('idp-f155-reject');
    const rejected = await decide('reject');
    expect(rejected.status, await rejected.clone().text()).toBe(200);
    expect((await w.instanceOf(plan, 2)).status).toBe('returned');
    expect((await w.readPlan(plan.id)).stages[1]!.status).toBe('running');
  });
});

describe('F-155a 阶段状态显示', () => {
  it('每个阶段状态都有文案，被跳过的阶段显示“已终止”', () => {
    expect(STAGE_STATUSES.filter((status) => !t.stageStatus[status])).toEqual([]);
    expect(t.stageStatus.terminated).toBe('已终止');
    expect(t.stageStatus.ended).toBe('已结束');
  });
});
