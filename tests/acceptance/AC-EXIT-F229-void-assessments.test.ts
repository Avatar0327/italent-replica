/**
 * F-229 / DEC-617：员工离职时在途考核（试用中考核 / 转正考核）的收口。
 * - 保存离职时提示（预览 warning + 沿用 §8 确认令牌的 409），确认后照常保存；
 * - 生效前考核保持在途、可继续审批；
 * - 生效时（approval / direct / free_direct 三种来源）在同一事务内把该员工的在途考核置为已作废（终态、只读），
 *   终止审批实例、移除待办、写审计；失败整单回滚。
 * 离职生效只经内部编排器入口 activateExit（§18.1 其余关口仍闭）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  assessmentExitWorld,
  EFFECTIVE_DAY,
  LAST_WORK_DATE,
  type AssessmentExitWorld,
} from './AC-EXIT-F229-support.js';
import { reasonOf as plainReason } from './AC-PB-BE15b1-support.js';
import { exitActivator } from './AC-EXIT-activation-support.js';
import { SYSTEM_USER_ID } from '../../apps/api/src/system-actor.js';
import { sql } from '@italent/db';

const database = useTestDb();
const world = (label: string) => assessmentExitWorld(database().db, label);

interface Preview {
  ack: { ackToken: string; assessments?: { items: { assessmentId: string }[] } } | null;
  warnings: {
    reason: string;
    items: { assessmentId?: string; assessmentType?: string; assessmentName?: string; message?: string }[];
    hiddenCount: number;
  }[];
}
const previewOf = async (x: AssessmentExitWorld, employeeId: string) => {
  const response = await x.previewCall(employeeId);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Preview;
};
const NOTICE = '存在审批中的转正考核流程，离职生效后会终止作废该流程';

describe('F-229 保存离职时的提示与确认（DEC-617）', () => {
  it('预览：有在途考核时追加 IN_FLIGHT_ASSESSMENT warning（类型 / 名称 / DEC-617 文案），只读不写', async () => {
    const x = await world('preview');
    const person = await x.probationer('预览员工');
    const assessmentId = await x.launch('regularization', person);
    const before = await x.assessmentRow(assessmentId);
    const preview = await previewOf(x, person.employeeId);
    const warning = preview.warnings.find((item) => item.reason === 'IN_FLIGHT_ASSESSMENT');
    expect(warning).toEqual({
      reason: 'IN_FLIGHT_ASSESSMENT',
      items: [
        {
          assessmentId,
          assessmentType: 'regularization',
          assessmentName: 'regularization-考核',
          assessmentDate: '2026-10-01',
          status: 'in_review',
          message: NOTICE,
        },
      ],
      hiddenCount: 0,
    });
    // 已有 warning 的结构与顺序不变，新的一类只追加在末尾
    expect(preview.warnings.map((item) => item.reason)).toEqual([
      'EXIT_APPLICATIONS_TO_VOID',
      'EXIT_FUTURE_TRANSFER_LANDED',
      'IN_FLIGHT_ASSESSMENT',
    ]);
    expect(preview.ack?.ackToken).toEqual(expect.any(String));
    expect(await x.assessmentRow(assessmentId)).toEqual(before);
  });

  it('预览：没有在途考核（含已通过 / 不通过）时没有该 warning，也没有确认令牌', async () => {
    const x = await world('preview-none');
    const done = await x.probationer('已通过员工');
    const finished = await x.launch('probation', done);
    await x.complete(finished, done);
    expect((await x.get(finished)).status).toBe('approved');
    const preview = await previewOf(x, done.employeeId);
    expect(preview.warnings.map((item) => item.reason)).toEqual([
      'EXIT_APPLICATIONS_TO_VOID',
      'EXIT_FUTURE_TRANSFER_LANDED',
    ]);
    expect(preview.ack).toBeNull();
  });

  it('直接离职：有在途考核不带确认 409 要确认并给出令牌；带令牌保存成功，令牌随离职单保存；无在途考核不要求确认', async () => {
    const x = await world('direct-ack');
    const person = await x.probationer('直接离职员工');
    const assessmentId = await x.launch('regularization', person);
    const missing = await x.reasonOf(
      await x.leaveCall(person.employeeId, { kind: 'leave', mode: 'direct', lastWorkDate: LAST_WORK_DATE, fields: {} }),
    );
    expect(missing).toMatchObject({ status: 409, reason: 'EXIT_IN_FLIGHT_ASSESSMENT_ACK_REQUIRED' });
    expect(missing.assessments).toMatchObject({ items: [{ assessmentId, message: NOTICE }], hiddenCount: 0 });
    expect(missing.ackToken).toEqual(expect.any(String));
    // 409 不留任何写入：考核仍在途
    expect((await x.assessmentRow(assessmentId)).status).toBe('in_review');
    const wrong = await x.reasonOf(
      await x.leaveCall(person.employeeId, {
        kind: 'leave',
        mode: 'direct',
        lastWorkDate: LAST_WORK_DATE,
        fields: {},
        exit: { pendingTransferAck: 'bogus' },
      }),
    );
    expect(wrong).toMatchObject({ status: 409, reason: 'EXIT_IN_FLIGHT_ASSESSMENT_ACK_REQUIRED' });
    const saved = await x.createdLeave(person.employeeId, 'direct', { pendingTransferAck: missing.ackToken });
    expect(saved.status).toBe('approved');
    // 生效前考核保持在途不变
    expect((await x.assessmentRow(assessmentId)).status).toBe('in_review');

    const free = await x.probationer('无考核员工');
    const plain = await x.createdLeave(free.employeeId, 'direct');
    expect(plain.status).toBe('approved');
  });

  it('离职申请：创建带确认；提交前新增在途考核则提交 409 要求按新集合重新确认；同一确认也覆盖已驳回待重提的考核', async () => {
    const x = await world('application-ack');
    const person = await x.probationer('申请员工');
    const first = await x.launch('probation', person);
    const required = await x.reasonOf(
      await x.leaveCall(person.employeeId, {
        kind: 'leave',
        mode: 'application',
        lastWorkDate: LAST_WORK_DATE,
        fields: {},
      }),
    );
    expect(required).toMatchObject({ status: 409, reason: 'EXIT_IN_FLIGHT_ASSESSMENT_ACK_REQUIRED' });
    const draft = await x.createdLeave(person.employeeId, 'application', { pendingTransferAck: required.ackToken });
    // 保存后、提交前，原考核被驳回、又新发起一个转正考核：集合变了
    await x.decide(first, person, 'approve', { selfEvaluation: '自评' });
    await x.decide(first, x.manager, 'reject');
    expect((await x.get(first)).status).toBe('rejected');
    const second = await x.launch('regularization', person);
    const stale = await x.reasonOf(await x.submitCall(draft));
    expect(stale).toMatchObject({ status: 409, reason: 'EXIT_IN_FLIGHT_ASSESSMENT_ACK_REQUIRED' });
    expect(stale.assessments?.items.map((item) => item.assessmentId).sort()).toEqual([first, second].sort());
    const submitted = await x.submitCall(draft, { pendingTransferAck: stale.ackToken });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
  });
});

describe('F-229 生效前不动', () => {
  it('离职保存后、审批中、计划生效日之前：考核仍在审批中，可以继续审批通过；未到日期不能生效', async () => {
    const x = await world('before-effect');
    const person = await x.probationer('生效前员工');
    const assessmentId = await x.launch('probation', person);
    const { ackToken } = await x.reasonOf(
      await x.leaveCall(person.employeeId, {
        kind: 'leave',
        mode: 'application',
        lastWorkDate: LAST_WORK_DATE,
        fields: {},
      }),
    );
    const draft = await x.createdLeave(person.employeeId, 'application', {
      exitTypeCode: 'voluntary',
      pendingTransferAck: ackToken,
    });
    expect((await x.submitCall(draft)).status).toBe(200);
    expect((await x.assessmentRow(assessmentId)).status).toBe('in_review');
    await x.complete(assessmentId, person);
    expect((await x.get(assessmentId)).status).toBe('approved');
    // 离职办到 approved、未到计划生效日：编排器拒绝，考核不受影响
    const view = await x.instanceOf(draft.id);
    const task = x.pending(view)[0]!;
    expect((await x.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {})).status).toBe(200);
    await expect(x.activate(draft.id, '2026-10-02')).rejects.toMatchObject({
      details: { reason: 'EFFECTIVE_DATE_NOT_REACHED' },
    });
    expect((await x.get(assessmentId)).status).toBe('approved');
  });
});

describe('F-229 生效时作废在途考核', () => {
  async function inFlight(
    x: AssessmentExitWorld,
    name: string,
    type: 'probation' | 'regularization' = 'regularization',
  ) {
    const person = await x.probationer(name);
    const assessmentId = await x.launch(type, person);
    return { person, assessmentId, instance: (await x.instanceRows(assessmentId))[0]! };
  }
  /** 作废后的统一断言：已作废终态、实例 cancelled、待办移除、审计一条。 */
  async function expectVoided(x: AssessmentExitWorld, assessmentId: string, instanceId: string, leaveId: string) {
    expect((await x.get(assessmentId)).status).toBe('cancelled');
    expect(await x.instanceRows(assessmentId)).toEqual([{ id: instanceId, status: 'cancelled' }]);
    expect(await x.pendingTaskCount(assessmentId)).toBe(0);
    const audit = await x.audits(assessmentId, 'employment.assessment.voided_by_exit');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before).toMatchObject({ status: 'in_review' });
    expect(audit[0]!.after).toMatchObject({ status: 'cancelled', exitBusinessId: leaveId });
  }

  it('直接离职（direct）生效：考核已作废、审批实例终止、待办移除、审计一条', async () => {
    const x = await world('void-direct');
    const { person, assessmentId, instance } = await inFlight(x, '直接生效员工');
    expect(await x.pendingTaskCount(assessmentId)).toBe(1);
    const { ackToken } = await x.reasonOf(
      await x.leaveCall(person.employeeId, { kind: 'leave', mode: 'direct', lastWorkDate: LAST_WORK_DATE, fields: {} }),
    );
    const leave = await x.createdLeave(person.employeeId, 'direct', { pendingTransferAck: ackToken });
    expect(await x.activate(leave.id, EFFECTIVE_DAY)).toMatchObject({ outcome: 'effective' });
    expect(await x.leaveStatus(leave.id)).toBe('effective');
    await expectVoided(x, assessmentId, instance.id, leave.id);
  });

  it('离职申请审批通过（approval）生效：同样作废', async () => {
    const x = await world('void-approval');
    const { person, assessmentId, instance } = await inFlight(x, '申请生效员工', 'probation');
    const { ackToken } = await x.reasonOf(
      await x.leaveCall(person.employeeId, {
        kind: 'leave',
        mode: 'application',
        lastWorkDate: LAST_WORK_DATE,
        fields: {},
      }),
    );
    const draft = await x.createdLeave(person.employeeId, 'application', {
      exitTypeCode: 'voluntary',
      pendingTransferAck: ackToken,
    });
    expect((await x.submitCall(draft)).status).toBe(200);
    const view = await x.instanceOf(draft.id);
    const task = x.pending(view)[0]!;
    expect((await x.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {})).status).toBe(200);
    expect(await x.activate(draft.id, EFFECTIVE_DAY, { trigger: 'scheduler', source: 'approval' })).toMatchObject({
      outcome: 'effective',
    });
    await expectVoided(x, assessmentId, instance.id, draft.id);
  });

  it('免审批直接生效（free_direct，DEC-593）：同样作废', async () => {
    const x = await world('void-free');
    const { person, assessmentId, instance } = await inFlight(x, '免审批员工');
    const { ackToken } = await x.reasonOf(
      await x.leaveCall(person.employeeId, { kind: 'leave', mode: 'direct', lastWorkDate: LAST_WORK_DATE, fields: {} }),
    );
    const leave = await x.createdLeave(person.employeeId, 'direct', { pendingTransferAck: ackToken });
    expect(await x.activate(leave.id, EFFECTIVE_DAY, { trigger: 'scheduler', source: 'free_direct' })).toMatchObject({
      outcome: 'effective',
    });
    await expectVoided(x, assessmentId, instance.id, leave.id);
  });

  it('已作废的考核只读：HR 修改 409、原审批待办不能再处理、不再出现在待办里', async () => {
    const x = await world('void-readonly');
    const { person, assessmentId } = await inFlight(x, '只读员工');
    const view = await x.instance(assessmentId);
    const task = x.pending(view)[0]!;
    const { ackToken } = await x.reasonOf(
      await x.leaveCall(person.employeeId, { kind: 'leave', mode: 'direct', lastWorkDate: LAST_WORK_DATE, fields: {} }),
    );
    const leave = await x.createdLeave(person.employeeId, 'direct', { pendingTransferAck: ackToken });
    await x.activate(leave.id, EFFECTIVE_DAY);
    const current = await x.get(assessmentId);
    const edited = await plainReason(await x.patchRaw(assessmentId, current.revision, { assessmentName: '改名' }));
    expect(edited).toMatchObject({ status: 409, reason: 'ASSESSMENT_NOT_EDITABLE' });
    const approved = await x.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
      comment: '迟到的同意',
    });
    expect(approved.status).toBeGreaterThanOrEqual(400);
    const todos = await x.todos(task.assigneeUserId);
    expect(todos.items.map((item) => item.taskId)).not.toContain(task.id);
    expect((await x.get(assessmentId)).status).toBe('cancelled');
  });

  it('非在途考核不被改动（已通过 / 不通过）；已驳回待重提的考核与在审批中的一并作废；同员工多条全部作废', async () => {
    const x = await world('void-mixed');
    const person = await x.probationer('多条员工');
    // 已通过
    const approved = await x.launch('probation', person);
    await x.complete(approved, person);
    // 不通过：经理不同意
    const disagreed = await x.launch('probation', person);
    await x.decide(disagreed, person, 'approve', { selfEvaluation: '自评' });
    await x.decide(disagreed, x.manager, 'disagree');
    // 已驳回待重提
    const rejected = await x.launch('probation', person);
    await x.decide(rejected, person, 'approve', { selfEvaluation: '自评' });
    await x.decide(rejected, x.manager, 'reject');
    // 在审批中
    const reviewing = await x.launch('regularization', person);
    expect((await x.get(approved)).status).toBe('approved');
    expect((await x.get(disagreed)).status).toBe('disapproved');
    expect((await x.get(rejected)).status).toBe('rejected');
    const approvedBefore = await x.assessmentRow(approved);
    const disagreedBefore = await x.assessmentRow(disagreed);

    const { ackToken, assessments } = await x.reasonOf(
      await x.leaveCall(person.employeeId, { kind: 'leave', mode: 'direct', lastWorkDate: LAST_WORK_DATE, fields: {} }),
    );
    expect(assessments?.items.map((item) => item.assessmentId).sort()).toEqual([rejected, reviewing].sort());
    const leave = await x.createdLeave(person.employeeId, 'direct', { pendingTransferAck: ackToken });
    await x.activate(leave.id, EFFECTIVE_DAY);

    for (const id of [rejected, reviewing]) expect((await x.get(id)).status).toBe('cancelled');
    expect(await x.assessmentRow(approved)).toEqual(approvedBefore);
    expect(await x.assessmentRow(disagreed)).toEqual(disagreedBefore);
    expect(await x.pendingTaskCount(reviewing)).toBe(0);
    expect((await x.instanceRows(rejected))[0]!.status).toBe('cancelled');
    expect(await x.audits(approved, 'employment.assessment.voided_by_exit')).toEqual([]);
  });

  it('其他员工（含同部门）的在途考核不受影响', async () => {
    const x = await world('void-others');
    const leaver = await inFlight(x, '离职员工');
    const colleague = await inFlight(x, '同部门同事', 'probation');
    const { ackToken } = await x.reasonOf(
      await x.leaveCall(leaver.person.employeeId, {
        kind: 'leave',
        mode: 'direct',
        lastWorkDate: LAST_WORK_DATE,
        fields: {},
      }),
    );
    const leave = await x.createdLeave(leaver.person.employeeId, 'direct', { pendingTransferAck: ackToken });
    await x.activate(leave.id, EFFECTIVE_DAY);
    expect((await x.get(leaver.assessmentId)).status).toBe('cancelled');
    expect((await x.get(colleague.assessmentId)).status).toBe('in_review');
    expect(await x.instanceRows(colleague.assessmentId)).toEqual([{ id: colleague.instance.id, status: 'running' }]);
    expect(await x.pendingTaskCount(colleague.assessmentId)).toBe(1);
  });

  it('生产调度（SYSTEM_USER_ID，不是租户成员）生效：同样作废，审计与审批日志的操作人为空', async () => {
    const x = await world('void-scheduler');
    const { person, assessmentId, instance } = await inFlight(x, '调度员工');
    const leave = await x.confirmedLeave(person.employeeId, 'direct');
    const asScheduler = exitActivator(x.db, { tenant: x.tenant, user: { id: SYSTEM_USER_ID } });
    expect(await asScheduler(leave.id, EFFECTIVE_DAY)).toMatchObject({ outcome: 'effective' });
    await expectVoided(x, assessmentId, instance.id, leave.id);
    expect((await x.audits(assessmentId, 'employment.assessment.voided_by_exit'))[0]!.actor).toBeNull();
    const [log] = await x.rows<{ actor: string | null }>(sql`SELECT actor_user_id AS actor FROM approval_instance_logs
      WHERE tenant_id=${x.tenantId} AND instance_id=${instance.id}::uuid AND event='system_revoke'`);
    expect(log).toEqual({ actor: null });
  });

  it('作废失败整单回滚：后续订阅方失败时离职不生效、考核与审批原样，修复后重试成功', async () => {
    const x = await world('void-rollback');
    const { person, assessmentId, instance } = await inFlight(x, '回滚员工');
    const { ackToken } = await x.reasonOf(
      await x.leaveCall(person.employeeId, { kind: 'leave', mode: 'direct', lastWorkDate: LAST_WORK_DATE, fields: {} }),
    );
    const leave = await x.createdLeave(person.employeeId, 'direct', { pendingTransferAck: ackToken });
    const { exitPostEffectHooks } = await import('../../apps/api/src/modules/employment/exit-confirmation.js');
    const { AppError } = await import('../../apps/api/src/errors.js');
    let fail = true;
    // 在考核订阅方之后注册：它失败时，前面已作废的考核必须随保存点一起回滚
    exitPostEffectHooks.onEffective(async () => {
      if (fail) throw new AppError('CONFLICT', '后续任务失败', { reason: 'DOWNSTREAM_FAILED' });
    });
    expect(await x.activate(leave.id, EFFECTIVE_DAY)).toMatchObject({ outcome: 'failed' });
    expect(await x.leaveStatus(leave.id)).toBe('approved');
    expect((await x.assessmentRow(assessmentId)).status).toBe('in_review');
    expect(await x.instanceRows(assessmentId)).toEqual([{ id: instance.id, status: 'running' }]);
    expect(await x.pendingTaskCount(assessmentId)).toBe(1);
    expect(await x.audits(assessmentId, 'employment.assessment.voided_by_exit')).toEqual([]);
    fail = false;
    expect(await x.activate(leave.id, EFFECTIVE_DAY)).toMatchObject({ outcome: 'effective' });
    expect((await x.get(assessmentId)).status).toBe('cancelled');
  });
});
