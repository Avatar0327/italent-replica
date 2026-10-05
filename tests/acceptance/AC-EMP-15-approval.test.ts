/**
 * AC-EMP-15（PR #54 第三轮复审 P2）：审批中编辑申请的循环汇报预检，按申请将来落地时的真实插入位置判断（DEC-108：
 * 按最近一次提交的操作先后，#53 timeline.ts），与到期落地同一口径。先提交的申请 A 会插在同日后保存的直接业务 B
 * 之前、当天就被 B 取代，A 的经理不生效；B 的经理若会被向后改成成环的值，只跳过该字段。
 * DEC-154：调动申请审批中不能再直接调动，同日在后的 B 用直接组织调整（其他直接业务仍按操作先后排序）。
 */
import { runEmploymentActivations } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const D = '2026-10-05';

interface RecordView {
  readonly id: string;
  readonly isCurrent: boolean;
  readonly fields: Readonly<Record<string, unknown>>;
}

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

async function revisionOf(w: ApprovalWorld, employeeId: string) {
  return (
    await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employeeId}`),
    )
  ).revision;
}

async function direct(
  w: ApprovalWorld,
  employeeId: string,
  effectiveDate: string,
  fields: Record<string, unknown>,
  kind: 'transfer' | 'org_adjustment' = 'transfer',
) {
  const response = await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
    ifMatch: await revisionOf(w, employeeId),
    body: { kind, mode: 'direct', effectiveDate, fields },
  });
  return w.json<{ id: string }>(response, 201);
}

async function recordsAt(w: ApprovalWorld, employeeId: string, asOf: string) {
  const response = await w.request(
    w.hr.id,
    'GET',
    `/api/tenant/employment/employees/${employeeId}/records?asOf=${asOf}`,
  );
  return (await w.json<{ items: RecordView[] }>(response)).items;
}

/** E 的经理为 X；M 稍后自 D+1 起汇报给 E。部门负责人审批，节点可编辑直线经理（独立【编辑】）。 */
async function scene(label: string) {
  const w = await approvalWorld(database().db, label);
  const department = await w.org('汇报线部门');
  const head = await w.person('部门负责人', department);
  await w.setOrgRoles(department, { head: head.employeeId });
  const x = await w.person('经理X', department);
  const m = await w.person('下属M', department);
  const e = await w.person('员工E', department, { directManagerId: x.employeeId });
  await w.publishedProcess({
    nodes: [
      {
        key: 'out_head',
        approver: 'latest_record_department_head',
        formFields: ['departmentId', 'directManagerId', 'effectiveDate'],
        editableFields: ['directManagerId'],
        editMode: 'separate',
      },
    ],
  });
  const editManager = (view: InstanceView, managerId: string) =>
    w.taskAction(head.userId, current(view).id, 'edit', view.revision, { fields: { directManagerId: managerId } });
  return { w, head, x, m, e, editManager };
}

describe('AC-EMP-15 审批中编辑申请：按申请落地时的真实插入位置判断循环汇报（PR #54 第三轮复审 P2）', () => {
  it('审批编辑＋同日后续直接业务＋到期落地：先提交的 A 被同日在后的 B 取代，改经理为 M 不误拒，落地后链不成环', async () => {
    const { w, head, x, m, e, editManager } = await scene('emp15-approval-edit');
    // A：先提交的调动申请，D 日生效、明确清空直线经理；B：之后保存的同日直接组织调整，经理为 X。
    const a = await w.application(e.employeeId, { directManagerId: null }, { effectiveDate: D });
    let view = await w.submit(a);
    const b = await direct(w, e.employeeId, D, { directManagerId: x.employeeId }, 'org_adjustment');
    // M 自 D+1 起汇报给 E：实际链 M→E→X。
    await direct(w, m.employeeId, '2026-10-06', { directManagerId: e.employeeId });

    const edited = await editManager(view, m.employeeId);
    expect(edited.status, await edited.clone().text()).toBe(200);
    view = (await edited.json()) as InstanceView;
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'out_head' });
    expect(view.logs).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'edit', nodeKey: 'out_head' })]),
    );
    expect((await w.business(a.id)).fields).toMatchObject({ directManagerId: m.employeeId });
    view = await w.json(await w.taskAction(head.userId, current(view).id, 'approve', view.revision));
    expect((await w.business(a.id)).status).toBe('approved');

    const run = await runEmploymentActivations(
      w.db,
      cmd(),
      { tenantId: w.tenant.id },
      { clock: () => new Date(`${D}T01:00:00.000Z`) },
    );
    expect(run.runs).toHaveLength(1);
    expect((await w.business(a.id)).status).toBe('effective');
    // 同日顺序：A 按提交先后插在 B 之前，当天被 B 取代；A 的经理为 M（不生效），当前任职仍是 B、经理 X。
    const records = await recordsAt(w, e.employeeId, D);
    expect(records.map((record) => record.id).filter((id) => id === a.id || id === b.id)).toEqual([a.id, b.id]);
    expect(records.find((record) => record.id === a.id)).toMatchObject({
      isCurrent: false,
      fields: { directManagerId: m.employeeId },
    });
    expect(records.find((record) => record.isCurrent)).toMatchObject({
      id: b.id,
      fields: { directManagerId: x.employeeId },
    });
  });

  it('反例：B 先保存、A 后提交时 A 排在当日最后、当天生效，改经理为 M 真实成环，仍拒绝且不写入', async () => {
    const { w, x, m, e, editManager } = await scene('emp15-approval-edit-cycle');
    await direct(w, e.employeeId, D, { directManagerId: x.employeeId });
    const a = await w.application(e.employeeId, { directManagerId: null }, { effectiveDate: D });
    const view = await w.submit(a);
    await direct(w, m.employeeId, '2026-10-06', { directManagerId: e.employeeId });

    const edited = await editManager(view, m.employeeId);
    expect(edited.status, await edited.clone().text()).toBe(400);
    expect(await edited.json()).toMatchObject({
      error: { message: '存在以下循环汇报，请修改。员工E 的直线经理汇报线循环：员工E→下属M→员工E（自 2026-10-06 起）' },
    });
    expect((await w.business(a.id)).fields).toMatchObject({ directManagerId: null });
    expect(await w.detail(view.id)).toMatchObject({
      status: 'running',
      currentNodeKey: 'out_head',
      revision: view.revision,
    });
  });
});
