/**
 * F-229 真 PostgreSQL 并发（普通角色 app_owner）：离职生效作废考核与考核审批通过同时进行。
 * 两条路径都先取员工行锁（审批回调：员工 → 考核记录 → 审批实例；离职生效：员工 → 考核记录按 ID 升序 → 审批实例），
 * 所以结果只能二选一、无双写：
 * - 审批先得锁：考核审批通过，之后生效时它已是终态，不被作废；
 * - 生效先得锁：考核已作废，迟到的审批通过被拒绝，审批实例也是已取消。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as assessmentStore from '../../apps/api/src/modules/employment/assessment-store.js';
import * as writeService from '../../apps/api/src/modules/employment/write-service.js';
import { assessmentExitWorld, EFFECTIVE_DAY, type AssessmentExitWorld } from './AC-EXIT-F229-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const world = (label: string) => assessmentExitWorld(database().db, label);

/** 员工自评已办完，只剩经理评价节点待办；返回经理的待办。 */
async function managerTask(
  x: AssessmentExitWorld,
  assessmentId: string,
  person: Awaited<ReturnType<typeof x.probationer>>,
) {
  await x.decide(assessmentId, person, 'approve', { selfEvaluation: '自评' });
  const view = await x.instance(assessmentId);
  const task = x.pending(view).find((item) => item.assigneeUserId === x.manager.userId)!;
  return { task, revision: view.revision };
}

/**
 * 迟到的审批通过必须以明确的业务错误被拒绝：不能是死锁 / 锁冲突转成的 409 APPROVAL_CONCURRENT_CONFLICT（40P01 / 40001 /
 * 55P03）或 5xx——那样即使锁序反转了断言也仍然通过（#424 第 1 轮 P2-1）。
 */
async function expectBusinessRejection(response: Response, expected: { code: string; reason?: string }) {
  const text = await response.clone().text();
  const body = JSON.parse(text) as { error?: { code?: string; details?: { reason?: string } } };
  expect(response.status, text).toBe(409);
  expect(body.error?.details?.reason, text).not.toBe('APPROVAL_CONCURRENT_CONFLICT');
  expect(body.error?.code, text).toBe(expected.code);
  if (expected.reason) expect(body.error?.details?.reason, text).toBe(expected.reason);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('F-229 离职生效与考核审批并发（真 PG，app_owner）', () => {
  afterEach(() => vi.restoreAllMocks());

  it('审批先得员工锁：生效在锁上等待，放行后考核已通过、不被作废，审批实例办结', async () => {
    const x = await world('race-approval-first');
    const person = await x.probationer('审批先行员工');
    const assessmentId = await x.launch('probation', person);
    const leave = await x.confirmedLeave(person.employeeId, 'direct');
    const { task, revision } = await managerTask(x, assessmentId, person);

    let entered!: () => void;
    let resume!: () => void;
    const enteredOnce = new Promise<void>((done) => (entered = done));
    const released = new Promise<void>((done) => (resume = done));
    const original = assessmentStore.saveAssessment;
    // 审批回调在写“审批通过”前暂停（此时已持员工锁与考核行锁）
    vi.spyOn(assessmentStore, 'saveAssessment').mockImplementation(async (...args) => {
      if (args[4] === 'approve') {
        entered();
        await released;
      }
      return original(...args);
    });
    const approving = x.taskAction(task.assigneeUserId, task.id, 'approve', revision, {});
    await enteredOnce;
    const activating = x.activate(leave.id, EFFECTIVE_DAY);
    await waitForBlocked(x.db, 1);
    resume();
    const [approved, activated] = await Promise.all([approving, activating]);
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(activated).toMatchObject({ outcome: 'effective' });
    expect((await x.get(assessmentId)).status).toBe('approved');
    expect((await x.instanceRows(assessmentId)).map((row) => row.status)).toEqual(['approved']);
    expect(await x.audits(assessmentId, 'employment.assessment.voided_by_exit')).toEqual([]);
    expect(await x.leaveStatus(leave.id)).toBe('effective');
  });

  it('生效先得员工锁：审批在锁上等待，放行后考核已作废，迟到的审批通过被拒绝且无双写', async () => {
    const x = await world('race-exit-first');
    const person = await x.probationer('生效先行员工');
    const assessmentId = await x.launch('probation', person);
    const leave = await x.confirmedLeave(person.employeeId, 'direct');
    const { task, revision } = await managerTask(x, assessmentId, person);

    let entered!: () => void;
    let resume!: () => void;
    const enteredOnce = new Promise<void>((done) => (entered = done));
    const released = new Promise<void>((done) => (resume = done));
    const original = writeService.materializeEmploymentRecord;
    // 生效在落地任职记录前暂停（此时已持员工锁，作废考核的订阅方还没运行）
    vi.spyOn(writeService, 'materializeEmploymentRecord').mockImplementation(async (...args) => {
      entered();
      await released;
      return original(...args);
    });
    const activating = x.activate(leave.id, EFFECTIVE_DAY);
    await enteredOnce;
    const approving = x.taskAction(task.assigneeUserId, task.id, 'approve', revision, {});
    await waitForBlocked(x.db, 1);
    resume();
    const [activated, approved] = await Promise.all([activating, approving]);
    expect(activated).toMatchObject({ outcome: 'effective' });
    // 审批请求带的是生效前读到的实例 revision；拿到员工锁后实例已被取消、revision 已变：版本冲突，不是死锁转换
    await expectBusinessRejection(approved, { code: 'REVISION_CONFLICT' });
    expect((await x.get(assessmentId)).status).toBe('cancelled');
    expect((await x.instanceRows(assessmentId)).map((row) => row.status)).toEqual(['cancelled']);
    expect(await x.pendingTaskCount(assessmentId)).toBe(0);
    expect(await x.audits(assessmentId, 'employment.assessment.voided_by_exit')).toHaveLength(1);
    expect(await x.audits(assessmentId, 'employment.assessment.approve')).toEqual([]);
    // 用生效后的最新 revision 再审批：实例已结束，明确的终态拒绝
    const latest = await x.instance(assessmentId);
    const retried = await x.taskAction(task.assigneeUserId, task.id, 'approve', latest.revision, {});
    await expectBusinessRejection(retried, { code: 'CONFLICT', reason: 'APPROVAL_TASK_CLOSED' });
  });

  it('不加屏障的同时发起：每名员工的考核要么通过要么作废，考核状态与审批实例状态一致、审计只有一方', async () => {
    const x = await world('race-free');
    const outcomes: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const person = await x.probationer(`同时员工${round}`);
      const assessmentId = await x.launch('probation', person);
      const leave = await x.confirmedLeave(person.employeeId, 'direct');
      const { task, revision } = await managerTask(x, assessmentId, person);
      const [activated, approved] = await Promise.all([
        x.activate(leave.id, EFFECTIVE_DAY),
        x.taskAction(task.assigneeUserId, task.id, 'approve', revision, {}),
      ]);
      expect(activated).toMatchObject({ outcome: 'effective' });
      const status = (await x.get(assessmentId)).status;
      const instance = (await x.instanceRows(assessmentId))[0]!.status;
      const voided = await x.audits(assessmentId, 'employment.assessment.voided_by_exit');
      const approvedAudit = await x.audits(assessmentId, 'employment.assessment.approve');
      if (status === 'approved') {
        expect([approved.status, instance, voided.length, approvedAudit.length]).toEqual([200, 'approved', 0, 1]);
      } else {
        await expectBusinessRejection(approved, { code: 'REVISION_CONFLICT' });
        expect([status, instance, voided.length, approvedAudit.length]).toEqual(['cancelled', 'cancelled', 1, 0]);
      }
      outcomes.push(status);
    }
    expect(outcomes.every((status) => ['approved', 'cancelled'].includes(status))).toBe(true);
  });
});
