/**
 * F-239（#424 F-229 审查后补测试）：离职申请在生效前被驳回 / 撤回，不作废在途考核。
 * 考核只在离职真正生效时作废（exit-void-assessments.ts 订阅 effective 端口）；驳回、撤回阶段不碰考核。
 * 之后重新发起并经公开入口（审批最后节点）生效，考核恰好作废一次：终态 cancelled、作废审计 1 条、outbox 作废事件 1 条、审批实例取消日志 1 条。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runEmploymentActivations } from '../../apps/api/src/modules/employment/activation-scheduler.js';
import { assessmentExitWorld, type AssessmentExitWorld } from './AC-EXIT-F229-support.js';
import { cmd } from './support/tenant-api.js';
import { sql } from '@italent/db';

const database = useTestDb();
const world = (label: string) => assessmentExitWorld(database().db, label);
/** 夹具时钟 10-01；最后工作日 10-02 → 计划生效日 10-03。 */
const DAY = '2026-10-03T01:00:00Z';
const VOIDED = 'employment.assessment.voided_by_exit';

async function inFlight(x: AssessmentExitWorld, name: string) {
  const person = await x.probationer(name);
  const assessmentId = await x.launch('regularization', person);
  return { person, assessmentId, instance: (await x.instanceRows(assessmentId))[0]! };
}

const BUSINESSES = '/api/tenant/employment/businesses';
const currentOf = async (x: AssessmentExitWorld, leaveId: string) =>
  x.json<{ id: string; revision: number }>(await x.request(x.hr.id, 'GET', `${BUSINESSES}/${leaveId}`));

/** 离职申请建单 → 提交（进入审批中心）；返回草稿与审批实例视图。 */
async function submittedApplication(x: AssessmentExitWorld, employeeId: string) {
  const draft = await x.confirmedLeave(employeeId, 'application', { exitTypeCode: 'voluntary' });
  return submitted(x, draft);
}
async function submitted(x: AssessmentExitWorld, draft: { id: string; revision: number }) {
  const response = await x.submitCall(draft);
  expect(response.status, await response.clone().text()).toBe(200);
  return { draft, view: await x.instanceOf(draft.id) };
}

const cancelLogs = (x: AssessmentExitWorld, instanceId: string) =>
  x.rows<{ id: string }>(sql`SELECT id FROM approval_instance_logs
    WHERE tenant_id=${x.tenantId} AND instance_id=${instanceId}::uuid AND event='cancel'`);

/** 作废事件（auditEmployment 与审计同事务写 employment_outbox）；下游按它收到“考核已被离职作废”。 */
const voidEvents = (x: AssessmentExitWorld, assessmentId: string) =>
  x.rows<{ payload: { after?: { exitBusinessId?: string } } }>(sql`SELECT payload FROM employment_outbox
    WHERE tenant_id=${x.tenantId} AND object_id=${assessmentId} AND event_type=${VOIDED}`);

/** 考核仍在途：状态、审批实例、待办原样，没有作废审计 / 作废事件 / 取消日志。 */
async function expectUntouched(x: AssessmentExitWorld, assessmentId: string, instanceId: string, revision: number) {
  expect(await x.assessmentRow(assessmentId)).toEqual({ status: 'in_review', revision });
  expect(await x.instanceRows(assessmentId)).toEqual([{ id: instanceId, status: 'running' }]);
  expect(await x.pendingTaskCount(assessmentId)).toBe(1);
  expect(await x.audits(assessmentId, VOIDED)).toEqual([]);
  expect(await voidEvents(x, assessmentId)).toEqual([]);
  expect(await cancelLogs(x, instanceId)).toEqual([]);
}

/** 重新发起的离职办到最后一个审批节点，经公开入口当场生效；考核恰好作废一次。 */
async function approveAndExpectOneVoid(
  x: AssessmentExitWorld,
  { draft, view }: Awaited<ReturnType<typeof submitted>>,
  assessmentId: string,
  instanceId: string,
) {
  x.setNow(DAY);
  const task = x.pending(view)[0]!;
  const done = await x.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {});
  expect(done.status, await done.clone().text()).toBe(200);
  expect(await x.leaveStatus(draft.id)).toBe('effective');
  expect((await x.get(assessmentId)).status).toBe('cancelled');
  expect(await x.instanceRows(assessmentId)).toEqual([{ id: instanceId, status: 'cancelled' }]);
  expect(await x.pendingTaskCount(assessmentId)).toBe(0);
  const audit = await x.audits(assessmentId, VOIDED);
  expect(audit).toHaveLength(1);
  expect(audit[0]!.after).toMatchObject({ status: 'cancelled', exitBusinessId: draft.id });
  const events = await voidEvents(x, assessmentId);
  expect(events).toHaveLength(1);
  expect(events[0]!.payload.after?.exitBusinessId).toBe(draft.id);
  expect(await cancelLogs(x, instanceId)).toHaveLength(1);
  // 生效已落地：调度再跑一遍不会重复作废
  const rerun = await runEmploymentActivations(x.db, cmd(), { tenantId: x.tenantId }, { clock: () => new Date(DAY) });
  expect(rerun.runs.flatMap((run) => run.activated)).toEqual([]);
  expect(await x.audits(assessmentId, VOIDED)).toHaveLength(1);
  expect(await voidEvents(x, assessmentId)).toHaveLength(1);
  expect(await cancelLogs(x, instanceId)).toHaveLength(1);
  return draft;
}

describe('F-239 离职生效前驳回 / 撤回：不作废在途考核', () => {
  it('生效前驳回：考核保持在途；重新发起并生效后恰好作废一次', async () => {
    const x = await world('reject');
    const { person, assessmentId, instance } = await inFlight(x, '驳回员工');
    const revision = (await x.assessmentRow(assessmentId)).revision;
    const { draft, view } = await submittedApplication(x, person.employeeId);
    const task = x.pending(view)[0]!;
    const rejected = await x.taskAction(task.assigneeUserId, task.id, 'reject', view.revision, { comment: '不同意' });
    expect(rejected.status, await rejected.clone().text()).toBe(200);
    expect(await x.leaveStatus(draft.id)).toBe('rejected');
    await expectUntouched(x, assessmentId, instance.id, revision);

    // 驳回单不会自己生效：计划生效日到了调度也不动它，考核仍在途
    const idle = await runEmploymentActivations(x.db, cmd(), { tenantId: x.tenantId }, { clock: () => new Date(DAY) });
    expect(idle.runs.flatMap((run) => run.activated)).toEqual([]);
    expect(await x.leaveStatus(draft.id)).toBe('rejected');
    await expectUntouched(x, assessmentId, instance.id, revision);

    // 被驳回的单有未办结状态（EXIT_IN_PROGRESS）：原发起人在同一单上修改后重提
    x.setNow('2026-10-01T01:00:00Z');
    const again = await submitted(x, await currentOf(x, draft.id));
    expect(again.draft.id).toBe(draft.id);
    await approveAndExpectOneVoid(x, again, assessmentId, instance.id);
  });

  it('生效前撤回：考核保持在途；另发离职并生效后恰好作废一次', async () => {
    const x = await world('withdraw');
    const { person, assessmentId, instance } = await inFlight(x, '撤回员工');
    const revision = (await x.assessmentRow(assessmentId)).revision;
    const { draft } = await submittedApplication(x, person.employeeId);
    const current = await currentOf(x, draft.id);
    const withdrawn = await x.request(x.hr.id, 'POST', `/api/tenant/employment/exits/${draft.id}/withdraw`, {
      ifMatch: current.revision,
    });
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    expect(await x.leaveStatus(draft.id)).toBe('draft');
    await expectUntouched(x, assessmentId, instance.id, revision);

    const idle = await runEmploymentActivations(x.db, cmd(), { tenantId: x.tenantId }, { clock: () => new Date(DAY) });
    expect(idle.runs.flatMap((run) => run.activated)).toEqual([]);
    await expectUntouched(x, assessmentId, instance.id, revision);

    // 撤回回到草稿后删除，再另发一条离职申请
    const back = await currentOf(x, draft.id);
    const removed = await x.request(x.hr.id, 'DELETE', `${BUSINESSES}/${draft.id}`, { ifMatch: back.revision });
    expect(removed.status, await removed.clone().text()).toBeLessThan(300);
    x.setNow('2026-10-01T01:00:00Z');
    const other = await submittedApplication(x, person.employeeId);
    expect(other.draft.id).not.toBe(draft.id);
    await approveAndExpectOneVoid(x, other, assessmentId, instance.id);
  });
});
