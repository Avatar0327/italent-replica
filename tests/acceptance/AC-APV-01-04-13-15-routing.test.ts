/**
 * REQ-APV-002 审批人动态解析：五种表达式、三种内建机制（相同 / 历史相同审批人跳过、审批人为空），
 * 首节点为空即报错（DEC-054），自审跳过转直线经理（DEC-058 / DEC-068）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, transferScene, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

describe('AC-APV-01/02 审批人按对象路径解析', () => {
  it('调出部门负责人取最新任职记录部门，调入 HRBP / 负责人取本条记录部门，一级组织上溯', async () => {
    const w = await approvalWorld(database().db, 'apv-route');
    const s = await transferScene(w);
    const division = await w.org('事业部');
    const team = await w.org('事业部下级', division);
    const divisionHead = await w.person('事业部负责人', division);
    const teamHead = await w.person('下级负责人', team);
    await w.setOrgRoles(division, { head: divisionHead.employeeId });
    await w.setOrgRoles(team, { head: teamHead.employeeId, hrbp: s.inHrbp.employeeId });
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const draft = await w.application(s.subject.employeeId, { departmentId: team });
    let view = await w.submit(draft);
    expect(view).toMatchObject({
      status: 'running',
      currentNodeKey: 'out_head',
      subjectEmployeeId: s.subject.employeeId,
    });
    expect(current(view)).toMatchObject({ nodeKey: 'out_head', assigneeUserId: s.outHead.userId, origin: 'resolved' });
    expect((await w.todos(s.outHead.userId)).items).toEqual([
      expect.objectContaining({ instanceId: view.id, nodeKey: 'out_head', isExceptionAdmin: false }),
    ]);
    expect((await w.todos(s.inHrbp.userId)).items).toEqual([]);

    const approve = async (assignee: string, nodeKey: string) => {
      const task = current(view);
      expect(task).toMatchObject({ nodeKey, assigneeUserId: assignee });
      view = await w.json(await w.taskAction(assignee, task.id, 'approve', view.revision, { comment: '同意' }));
    };
    await approve(s.outHead.userId, 'out_head');
    await approve(s.inHrbp.userId, 'in_hrbp');
    await approve(teamHead.userId, 'in_head');
    await approve(divisionHead.userId, 'first_level');
    expect(view.status).toBe('approved');
    expect(await w.business(draft.id)).toMatchObject({ status: 'effective' });
  });
});

describe('AC-APV-01/02 编辑并同意后按编辑后的单据解析后续审批人', () => {
  it('编辑并同意改了调入部门：调入 HRBP / 负责人节点派给新部门，而不是编辑前的部门', async () => {
    const w = await approvalWorld(database().db, 'apv-edit-route');
    const s = await transferScene(w);
    const other = await w.org('改派部门');
    const otherHead = await w.person('改派负责人', other);
    const otherHrbp = await w.person('改派HRBP', other);
    await w.setOrgRoles(other, { head: otherHead.employeeId, hrbp: otherHrbp.employeeId });
    const editable = { formFields: ['departmentId'], editableFields: ['departmentId'] } as const;
    await w.publishedProcess({
      nodes: [{ ...TRANSFER_NODES[0]!, ...editable, editMode: 'with_approve' }, TRANSFER_NODES[1]!, TRANSFER_NODES[2]!],
    });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    let view = await w.submit(draft);
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision, {
        comment: '改调入部门',
        fields: { departmentId: other },
      }),
    );
    expect(current(view)).toMatchObject({ nodeKey: 'in_hrbp', assigneeUserId: otherHrbp.userId });
    view = await w.json(await w.taskAction(otherHrbp.userId, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ nodeKey: 'in_head', assigneeUserId: otherHead.userId });
    expect((await w.todos(s.inHrbp.userId)).items).toEqual([]);
    expect((await w.business(draft.id)).fields).toMatchObject({ departmentId: other });
  });
});

describe('AC-APV-03 相同审批人跳过 / 历史相同审批人跳过（结果 = 同意）', () => {
  it('调出与调入负责人为同一人时，第二个节点自动同意并写节点日志', async () => {
    const w = await approvalWorld(database().db, 'apv-same');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { head: s.outHead.employeeId });
    await w.publishedProcess({
      nodes: [
        { key: 'out_head', approver: 'latest_record_department_head', sameAssigneeSkip: true },
        { key: 'in_head', approver: 'record_department_head', sameAssigneeSkip: true },
        { key: 'in_hrbp', approver: 'record_department_hrbp' },
        { key: 'again', approver: 'record_department_head', historySameAssigneeSkip: true },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ nodeKey: 'in_hrbp', assigneeUserId: s.inHrbp.userId });
    expect(view.tasks.find((t) => t.nodeKey === 'in_head')).toMatchObject({ status: 'skipped', origin: 'same_skip' });
    expect(view.logs).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'same_assignee_skip' })]));
    view = await w.json(await w.taskAction(s.inHrbp.userId, current(view).id, 'approve', view.revision));
    expect(view.tasks.find((t) => t.nodeKey === 'again')).toMatchObject({ status: 'skipped', origin: 'history_skip' });
    expect(view.status).toBe('approved');
  });
});

describe('AC-APV-04 中间节点审批人为空 → 异常管理员', () => {
  it('调入部门未设 HRBP：任务派给异常管理员并标注', async () => {
    const w = await approvalWorld(database().db, 'apv-empty-middle');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    const admin = await w.member('异常管理员');
    await w.publishedProcess({ nodes: TRANSFER_NODES, exceptionAdminUserId: admin });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({
      nodeKey: 'in_hrbp',
      assigneeUserId: admin,
      origin: 'exception_admin',
      isExceptionAdmin: true,
    });
    expect(view.logs).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'no_assignee_exception_admin', nodeKey: 'in_hrbp' })]),
    );
    expect((await w.todos(admin)).items).toEqual([
      expect.objectContaining({ nodeKey: 'in_hrbp', isExceptionAdmin: true }),
    ]);
  });

  it('节点配置“审批人为空自动跳过 / 自动同意”时不派异常管理员', async () => {
    const w = await approvalWorld(database().db, 'apv-empty-skip');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({
      nodes: [
        { key: 'out_head', approver: 'latest_record_department_head' },
        { key: 'skip', approver: 'record_department_hrbp', noAssignee: 'skip' },
        { key: 'auto', approver: 'record_department_hrbp', noAssignee: 'approve' },
        { key: 'in_head', approver: 'record_department_head' },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ nodeKey: 'in_head', assigneeUserId: s.inHead.userId });
    expect(view.tasks.find((t) => t.nodeKey === 'skip')).toMatchObject({
      status: 'skipped',
      origin: 'no_assignee_skip',
    });
    expect(view.tasks.find((t) => t.nodeKey === 'auto')).toMatchObject({
      status: 'skipped',
      origin: 'no_assignee_approve',
    });
  });
});

describe('AC-APV-13 首节点没有审批人：提交即报错（DEC-054）', () => {
  it('不生成实例，任职申请保持草稿；修复后可正常提交', async () => {
    const w = await approvalWorld(database().db, 'apv-first-empty');
    const s = await transferScene(w);
    await w.setOrgRoles(s.from, { head: null });
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const response = await w.submitRaw(draft);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'CONFLICT',
        message: '第一个审批节点没有审批人',
        details: { reason: 'APPROVAL_FIRST_NODE_EMPTY' },
      },
    });
    expect(await w.business(draft.id)).toMatchObject({ status: 'draft', revision: draft.revision });
    const list = await w.request(
      w.hr.id,
      'GET',
      `/api/tenant/approval/instances?role=initiated&businessId=${draft.id}`,
    );
    expect(await list.json()).toMatchObject({ items: [] });
    await w.setOrgRoles(s.from, { head: s.outHead.employeeId });
    expect(current(await w.submit(draft))).toMatchObject({ assigneeUserId: s.outHead.userId });
  });
});

describe('AC-APV-15 自审跳过（DEC-058 / DEC-068）', () => {
  it('发起人被解析为审批人：跳过（不计同意）并转其直线经理；优先于相同审批人跳过', async () => {
    const w = await approvalWorld(database().db, 'apv-self');
    const s = await transferScene(w);
    const boss = await w.person('经理的经理', s.from);
    const initiator = await w.person('发起经理', s.from, { directManagerId: boss.employeeId });
    await w.setOrgRoles(s.from, { head: initiator.employeeId });
    await w.publishedProcess({
      nodes: [
        { key: 'out_head', approver: 'latest_record_department_head', sameAssigneeSkip: true },
        { key: 'in_head', approver: 'record_department_head' },
      ],
    });
    const view = await w.submit(
      await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: initiator.userId }),
      initiator.userId,
    );
    expect(current(view)).toMatchObject({
      nodeKey: 'out_head',
      assigneeUserId: boss.userId,
      origin: 'self_skip_manager',
    });
    const skipped = view.tasks.find((task) => task.assigneeUserId === initiator.userId);
    expect(skipped).toMatchObject({ status: 'skipped', origin: 'self_skip' });
    expect(view.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'self_skip',
          nodeKey: 'out_head',
          detail: expect.objectContaining({ countedAsApprove: false }),
        }),
      ]),
    );
    expect(view.logs.some((log) => log.event === 'approve' && log.actorUserId === initiator.userId)).toBe(false);
  });

  it('异动员工本人被解析为审批人：直线经理为空、仍为本人或已在审批链上时转异常管理员', async () => {
    const w = await approvalWorld(database().db, 'apv-self-subject');
    const s = await transferScene(w);
    const admin = await w.member('异常管理员');
    // 员工本人是调入部门负责人；其直线经理 manager 同时是调出部门负责人（已在审批链上）。
    await w.setOrgRoles(s.from, { head: s.manager.employeeId });
    await w.setOrgRoles(s.to, { head: s.subject.employeeId });
    await w.publishedProcess({
      exceptionAdminUserId: admin,
      nodes: [
        { key: 'out_head', approver: 'latest_record_department_head' },
        { key: 'in_head', approver: 'record_department_head' },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.manager.userId, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ nodeKey: 'in_head', assigneeUserId: admin, isExceptionAdmin: true });
    expect(view.tasks.find((t) => t.assigneeUserId === s.subject.userId)).toMatchObject({
      status: 'skipped',
      origin: 'self_skip',
    });

    const lonely = await w.person('无经理员工', s.from);
    await w.setOrgRoles(s.from, { head: lonely.employeeId });
    const other = await w.submit(await w.application(lonely.employeeId, { departmentId: s.to }));
    expect(current(other)).toMatchObject({ nodeKey: 'out_head', assigneeUserId: admin, isExceptionAdmin: true });
  });
});
