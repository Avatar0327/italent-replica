/**
 * R2-T03 B2b / AC-DM-22（#388 第 1 轮 P1，DEC-455）：审批中编辑离职单与 HR 编辑同约束（设计 §4 / §4B / §9.1）——
 * 审批人除节点开放的字段与字段编辑权外，还要 Employment.DimissionEdit 与审批管理员按钮 adminIntervene。
 * 独立编辑（tasks/:id/edit）与编辑并同意（tasks/:id/approve 带 fields）都在命令事务内复核；缺任一按钮 403，
 * 业务、任务、实例、审计与 outbox 逐项不变；两个按钮都有时成功。审批人不走 HR 员工范围（DEC-057）。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene } from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { denyButtons, stateSnapshot } from './AC-EXIT-gate-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const LATER = '2026-10-20';

async function scene(label: string, editMode: 'separate' | 'with_approve') {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await installExitSeeds(w.db, w.tenant.id);
  await w.publishedProcess({
    approvalType: 'leave',
    conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] },
    nodes: [
      {
        key: 'out_head',
        approver: 'latest_record_department_head',
        formFields: ['lastWorkDate', 'effectiveDate', 'exitTypeCode', 'actualLeaveDate'],
        editableFields: ['exitTypeCode', 'actualLeaveDate'],
        editMode,
      },
    ],
  });
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
  );
  const draft = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: {
        kind: 'leave',
        mode: 'application',
        lastWorkDate: LATER,
        fields: {},
        exit: { exitTypeCode: 'voluntary' },
      },
    }),
    201,
  );
  const instance = await w.submit(draft);
  const task = w.pending(instance)[0]!;
  /** 审批人（调出部门负责人）用受限授权器发请求。 */
  const asApprover = (authorize: Authorizer, action: 'edit' | 'approve', fields: Record<string, unknown>) =>
    tenantApi(w.db, { authorize, clock: w.clock }).request('POST', `/api/tenant/approval/tasks/${task.id}/${action}`, {
      ...w.as(s.outHead.userId),
      ifMatch: instance.revision,
      body: { fields },
    });
  return { w, s, draft, instance, task, asApprover };
}

describe('AC-DM-22 #388 P1 审批编辑离职单须 DimissionEdit + adminIntervene（DEC-455）', () => {
  for (const editMode of ['separate', 'with_approve'] as const) {
    it(`${editMode === 'separate' ? '独立编辑' : '编辑并同意'}：缺任一按钮 403 且逐项不变；两个按钮都有 200`, async () => {
      const { w, s, draft, instance, task, asApprover } = await scene(`approval-edit-${editMode}`, editMode);
      const action = editMode === 'separate' ? 'edit' : 'approve';
      const before = await stateSnapshot(w.db, w.tenant.id, s.subject.employeeId);
      for (const button of ['Employment.DimissionEdit', 'adminIntervene']) {
        const denied = await asApprover(denyButtons(button), action, { exitTypeCode: 'involuntary' });
        expect(denied.status, `${button} ${await denied.clone().text()}`).toBe(403);
        expect(await stateSnapshot(w.db, w.tenant.id, s.subject.employeeId), button).toEqual(before);
      }
      const after = await w.detail(instance.id);
      expect({ revision: after.revision, pending: w.pending(after).map((t) => t.id) }).toEqual({
        revision: instance.revision,
        pending: [task.id],
      });
      const ok = await asApprover(denyButtons(), action, { exitTypeCode: 'involuntary' });
      expect(ok.status, await ok.clone().text()).toBe(200);
      expect(await w.business(draft.id)).toMatchObject({
        status: editMode === 'separate' ? 'in_review' : 'approved',
      });
    });
  }
});

describe('AC-DM-22 #388 P2-2 审批编辑的实际离岗日不晚于最后工作日（设计 §2.1）', () => {
  it('审批编辑改成最后工作日次日 400 且逐项不变；等于最后工作日 200', async () => {
    const { w, s, asApprover } = await scene('approval-edit-actual', 'separate');
    const before = await stateSnapshot(w.db, w.tenant.id, s.subject.employeeId);
    const late = await asApprover(denyButtons(), 'edit', { actualLeaveDate: '2026-10-21' });
    expect(late.status).toBe(400);
    expect(await late.text()).toContain('EXIT_ACTUAL_LEAVE_DATE_AFTER_LAST_WORK_DATE');
    expect(await stateSnapshot(w.db, w.tenant.id, s.subject.employeeId)).toEqual(before);
    const ok = await asApprover(denyButtons(), 'edit', { actualLeaveDate: LATER });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });
});
