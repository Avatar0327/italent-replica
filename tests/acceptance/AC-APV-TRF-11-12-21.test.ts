/**
 * REQ-APV-003 审批中编辑与原值显示：AC-TRF-11（独立编辑按钮，保存后仍停在本节点）、
 * AC-TRF-12（编辑与同意合一）、AC-TRF-21（「审批详情页显示原信息」开关）；
 * 审批通过 ≠ 生效：生效日已到立即生效，未到保持「审批通过」等 R1-T08（AC-TRF-05 / 06）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

describe('AC-TRF-11 / AC-TRF-12 审批中编辑', () => {
  it('独立【编辑】保存后流程仍停在当前节点；【编辑并同意】提交即通过；只能编辑节点可编辑字段', async () => {
    const w = await approvalWorld(database().db, 'apv-edit');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        {
          key: 'out_head',
          approver: 'latest_record_department_head',
          formFields: ['departmentId', 'place', 'effectiveDate'],
          editableFields: ['place'],
          editMode: 'separate',
        },
        {
          key: 'in_head',
          approver: 'record_department_head',
          formFields: ['departmentId', 'place', 'remarks'],
          editableFields: ['remarks'],
          editMode: 'with_approve',
        },
      ],
    });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to, place: '原地点' });
    let view = await w.submit(draft);
    expect(view.form).toMatchObject({ nodeKey: 'out_head', values: { place: '原地点', departmentId: s.to } });
    const outside = await w.taskAction(s.outHead.userId, current(view).id, 'edit', view.revision, {
      fields: { remarks: '越界' },
    });
    expect(outside.status).toBe(403);
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'edit', view.revision, {
        fields: { place: '审批改地点' },
      }),
    );
    expect(view).toMatchObject({
      status: 'running',
      currentNodeKey: 'out_head',
      form: { values: { place: '审批改地点' } },
    });
    expect(current(view)).toMatchObject({ assigneeUserId: s.outHead.userId });
    expect(view.logs).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'edit', nodeKey: 'out_head' })]),
    );
    const merged = await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision, {
      fields: { place: '不允许合并' },
    });
    expect(merged.status).toBe(409);
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(view.currentNodeKey).toBe('in_head');
    expect(
      (await w.taskAction(s.inHead.userId, current(view).id, 'edit', view.revision, { fields: { remarks: 'x' } }))
        .status,
    ).toBe(409);
    view = await w.json(
      await w.taskAction(s.inHead.userId, current(view).id, 'approve', view.revision, {
        fields: { remarks: '合并编辑' },
      }),
    );
    expect(view.status).toBe('approved');
    expect(await w.business(draft.id)).toMatchObject({
      status: 'effective',
      fields: { place: '审批改地点', remarks: '合并编辑', departmentId: s.to },
    });
  });
});

describe('AC-TRF-21 审批详情页显示原信息（租户开关，出厂开）', () => {
  it('开：表单附带变更前原值（来自版本链上一条）；关：不显示', async () => {
    const w = await approvalWorld(database().db, 'apv-original');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [{ key: 'out_head', approver: 'latest_record_department_head', formFields: ['departmentId', 'place'] }],
    });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const shown = await w.detail(view.id, s.outHead.userId);
    expect(shown.form).toMatchObject({ values: { departmentId: s.to }, originals: { departmentId: s.from } });
    const off = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/approval.show_original_values', {
      ifMatch: 0,
      body: { value: false },
    });
    expect(off.status, await off.clone().text()).toBe(200);
    const hidden = await w.detail(view.id, s.outHead.userId);
    expect(hidden.form.values).toMatchObject({ departmentId: s.to });
    expect(hidden.form.originals).toBeUndefined();
  });
});

describe('AC-TRF-05 / AC-TRF-06 审批通过 ≠ 生效', () => {
  it('生效日在未来：审批通过后保持「审批通过」，不生成任职记录', async () => {
    const w = await approvalWorld(database().db, 'apv-future');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [{ key: 'out_head', approver: 'latest_record_department_head' }] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to }, { effectiveDate: '2026-10-20' });
    const view = await w.submit(draft);
    const done = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision),
    );
    expect(done.status).toBe('approved');
    expect(await w.business(draft.id)).toMatchObject({ status: 'approved', record: null });
  });
});
