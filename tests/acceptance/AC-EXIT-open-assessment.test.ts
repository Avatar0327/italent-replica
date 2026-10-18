/**
 * R2-T03 B3-3 + F-229（#424）：离职开闸后，有在途考核的员工经公开入口离职生效——直接保存、调度、审批最后节点三个入口：
 * 考核置 cancelled、审批实例取消、待办清除，不报错；生效响应的命令台账重放与撤权复核把考核的联动改写足迹一并纳入
 * （employment-replay.ts：probation-assessment 的目标解析与联动动作分类）。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runEmploymentActivations } from '../../apps/api/src/modules/employment/activation-scheduler.js';
import { assessmentExitWorld, LAST_WORK_DATE, type AssessmentExitWorld } from './AC-EXIT-F229-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const world = (label: string) => assessmentExitWorld(database().db, label);
/** 夹具时钟 10-01；最后工作日 10-02 → 计划生效日 10-03。 */
const DAY = '2026-10-03T01:00:00Z';

async function inFlight(x: AssessmentExitWorld, name: string, type: 'probation' | 'regularization' = 'regularization') {
  const person = await x.probationer(name);
  const assessmentId = await x.launch(type, person);
  return { person, assessmentId, instance: (await x.instanceRows(assessmentId))[0]! };
}

/** 作废后的统一断言：已作废终态、实例 cancelled、待办清除、审计一条。 */
async function expectVoided(x: AssessmentExitWorld, assessmentId: string, instanceId: string, leaveId: string) {
  expect((await x.get(assessmentId)).status).toBe('cancelled');
  expect(await x.instanceRows(assessmentId)).toEqual([{ id: instanceId, status: 'cancelled' }]);
  expect(await x.pendingTaskCount(assessmentId)).toBe(0);
  const audit = await x.audits(assessmentId, 'employment.assessment.voided_by_exit');
  expect(audit).toHaveLength(1);
  expect(audit[0]!.after).toMatchObject({ status: 'cancelled', exitBusinessId: leaveId });
}

const directBody = { kind: 'leave', mode: 'direct', lastWorkDate: LAST_WORK_DATE, fields: {} };

describe('F-229 × B3-3：有在途考核的员工经公开入口离职生效', () => {
  it('直接保存：计划生效日已到，保存事务内生效并作废考核；同键重放返回原响应', async () => {
    const x = await world('open-direct');
    const { person, assessmentId, instance } = await inFlight(x, '直接保存员工');
    x.setNow(DAY);
    const { ackToken } = await x.reasonOf(await x.leaveCall(person.employeeId, directBody));
    const key = randomUUID();
    const revision = await x.employeeRevision(person.employeeId);
    const first = await x.request(
      x.hr.id,
      'POST',
      '/api/tenant/employment/employees/' + person.employeeId + '/businesses',
      { ifMatch: revision, body: { ...directBody, exit: { pendingTransferAck: ackToken } }, idempotencyKey: key },
    );
    expect(first.status, await first.clone().text()).toBe(201);
    const leave = (await first.json()) as { id: string; status: string };
    expect(leave.status).toBe('effective');
    await expectVoided(x, assessmentId, instance.id, leave.id);

    // 重放：命令台账返回后重验（含考核足迹），原响应原样返回，不重复作废
    const replay = await x.request(
      x.hr.id,
      'POST',
      '/api/tenant/employment/employees/' + person.employeeId + '/businesses',
      { ifMatch: revision, body: { ...directBody, exit: { pendingTransferAck: ackToken } }, idempotencyKey: key },
    );
    expect(replay.status, await replay.clone().text()).toBe(201);
    expect(await x.audits(assessmentId, 'employment.assessment.voided_by_exit')).toHaveLength(1);
  });

  it('调度到期：考核作废，生效尝试记 effective', async () => {
    const x = await world('open-scheduler');
    const { person, assessmentId, instance } = await inFlight(x, '调度员工');
    const leave = await x.confirmedLeave(person.employeeId, 'direct');
    expect(leave.status).toBe('approved');
    expect(await x.pendingTaskCount(assessmentId)).toBe(1);
    const result = await runEmploymentActivations(
      x.db,
      cmd(),
      { tenantId: x.tenantId },
      { clock: () => new Date(DAY) },
    );
    expect(result.runs[0]).toMatchObject({ activated: [leave.id], failed: [], errors: [] });
    await expectVoided(x, assessmentId, instance.id, leave.id);
  });

  it('审批最后节点：审批事务内生效并作废考核，审批动作成功', async () => {
    const x = await world('open-approval');
    const { person, assessmentId, instance } = await inFlight(x, '审批员工');
    const draft = await x.confirmedLeave(person.employeeId, 'application', { exitTypeCode: 'voluntary' });
    expect((await x.submitCall(draft)).status).toBe(200);
    x.setNow(DAY);
    const view = await x.instanceOf(draft.id);
    const task = x.pending(view)[0]!;
    const done = await x.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {});
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await x.leaveStatus(draft.id)).toBe('effective');
    await expectVoided(x, assessmentId, instance.id, draft.id);
  });

  it('撤权复核：同键重放时 HR 已无离职相关权限 → 403，不返回缓存的 201', async () => {
    const x = await world('open-revoke');
    const { person } = await inFlight(x, '撤权员工');
    x.setNow(DAY);
    const { ackToken } = await x.reasonOf(await x.leaveCall(person.employeeId, directBody));
    const key = randomUUID();
    const path = '/api/tenant/employment/employees/' + person.employeeId + '/businesses';
    const body = { ...directBody, exit: { pendingTransferAck: ackToken } };
    const revision = await x.employeeRevision(person.employeeId);
    const first = await x.request(x.hr.id, 'POST', path, {
      ifMatch: revision,
      body,
      idempotencyKey: key,
    });
    expect(first.status, await first.clone().text()).toBe(201);
    // 同一用户撤掉“直接离职”按钮后重放同一命令：整条权限链重新执行，不返回缓存响应
    const revoked = tenantApi(x.db, {
      authorize: (request) =>
        !(request.action === 'object.button' && String(request.resource).includes('#Employment.Dimission@')),
      clock: () => new Date(DAY),
    });
    const replay = await revoked.request('POST', path, {
      user: x.hr.id,
      tenant: x.tenantId,
      ifMatch: revision,
      body,
      idempotencyKey: key,
    });
    expect(replay.status, await replay.clone().text()).toBe(403);
  });
});
