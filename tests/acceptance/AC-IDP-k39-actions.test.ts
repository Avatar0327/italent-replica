/**
 * DEC-318 K-39：IDP 审批不再一刀切禁用驳回 / 撤回 / 重提 / 编辑，按原站节点开关：
 * - 指导人节点：同意、驳回（到发起人，发起人 = 计划所有者重提后从头走）、驳回到上一步（回到员工节点，员工再提交后按
 *   正常顺序到指导人）、跳转（到本流程的其他节点）；
 * - 员工节点：同意、跳转；不能驳回 / 驳回到上一步；
 * - 撤回由节点开关 revoke（原站 isRevoke）控制，预置流程关闭；打开时所有者可撤回、撤回后可重提；
 * - 审批中编辑由节点配置（editMode 与 IDP 节点按钮）决定：预置节点 editMode = none，审批中心编辑 409；
 * - 详情公布的动作与实际允许的一致（第 2 轮 P3-1）。
 */
import { PRESET_PROCESSES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, planWorld, type PlanWorld, type PlanView } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const APV = '/api/tenant/approval';

const EMPLOYEE = { avoidSelf: false, reject: false, jump: true, revoke: false };
const TUTOR = { avoidSelf: false, reject: true, rejectToPrevious: true, jump: true, revoke: false };

async function world(label: string, extra: { revoke?: boolean } = {}) {
  return planWorld(testDb().db, label, {
    nodes: {
      idp_employee: { actions: { ...EMPLOYEE, ...extra } },
      idp_tutor: { actions: { ...TUTOR, ...extra } },
    },
  });
}

const pendingOf = async (w: PlanWorld, plan: PlanView) =>
  (await w.instanceOf(plan, 1)).tasks.filter((t) => t.status === 'pending');

function taskPost(w: PlanWorld, user: string, taskId: string, path: string, revision: number, body = {}) {
  return w.http(user, 'POST', `${APV}/tasks/${taskId}/${path}`, { ifMatch: revision, body });
}

describe('K-39：预置节点开关', () => {
  it('员工节点：驳回关、跳转开、撤回关；指导人节点：驳回 / 驳回到上一步 / 跳转开、撤回关', () => {
    for (const type of ['idp_plan', 'idp_mid_review', 'idp_final_review']) {
      const [employee, tutor] = PRESET_PROCESSES.find((p) => p.approvalType === type)!.definition.nodes;
      expect(employee!.actions, type).toMatchObject({ reject: false, jump: true, revoke: false });
      expect(employee!.actions.rejectToPrevious ?? false, type).toBe(false);
      expect(tutor!.actions, type).toMatchObject({ reject: true, rejectToPrevious: true, jump: true, revoke: false });
    }
  });
});

describe('K-39：节点动作', () => {
  it('详情公布的动作与允许的一致；员工驳回 409；员工跳转到指导人节点', async () => {
    const w = await world('idp-k39-employee');
    const plan = await w.startedPlan();
    const { instance, task } = await w.pendingTask(plan, 1, w.employee.userId);
    const asEmployee = await w.detail(instance.id, w.employee.userId);
    expect(asEmployee.actions).toEqual(expect.arrayContaining(['approve', 'jump']));
    expect(asEmployee.actions).not.toContain('reject');
    expect(asEmployee.actions).not.toContain('rejectPrevious');
    expect((await w.detail(instance.id, w.hrUser)).actions).not.toContain('withdraw');

    const rejected = await taskPost(w, w.employee.userId, task.id, 'reject', instance.revision);
    expect(await errorOf(rejected)).toMatchObject({ status: 409, reason: 'APPROVAL_ACTION_DISABLED' });
    const previous = await taskPost(w, w.employee.userId, task.id, 'reject-previous', instance.revision);
    expect(await errorOf(previous)).toMatchObject({ status: 409, reason: 'APPROVAL_ACTION_DISABLED' });
    const jumped = await taskPost(w, w.employee.userId, task.id, 'jump', instance.revision, {
      toNodeKey: 'approve_plan',
      comment: '直接给指导人',
    });
    expect(jumped.status, await jumped.clone().text()).toBe(200);
    expect(await pendingOf(w, plan)).toEqual([
      expect.objectContaining({ nodeKey: 'approve_plan', assigneeUserId: w.manager.userId }),
    ]);
  });

  it('指导人驳回到上一步：回到员工节点，员工再提交后按顺序回到指导人，指导人同意后阶段结束', async () => {
    const w = await world('idp-k39-previous');
    const plan = await w.startedPlan();
    await w.submit(plan, 1, w.employee.userId);
    const { instance, task } = await w.pendingTask(plan, 1, w.manager.userId);
    const asTutor = await w.detail(instance.id, w.manager.userId);
    expect(asTutor.actions).toEqual(expect.arrayContaining(['approve', 'reject', 'rejectPrevious', 'jump']));
    const back = await taskPost(w, w.manager.userId, task.id, 'reject-previous', instance.revision, {
      comment: '目标再细化',
    });
    expect(back.status, await back.clone().text()).toBe(200);
    expect(await pendingOf(w, plan)).toEqual([
      expect.objectContaining({ nodeKey: 'set_goals', assigneeUserId: w.employee.userId }),
    ]);
    await w.submit(plan, 1, w.employee.userId);
    expect(await pendingOf(w, plan)).toEqual([
      expect.objectContaining({ nodeKey: 'approve_plan', assigneeUserId: w.manager.userId }),
    ]);
    const done = await w.submit(plan, 1, w.manager.userId);
    expect(done.stages[0]!.status).toBe('ended');
  });

  it('指导人跳转到员工节点', async () => {
    const w = await world('idp-k39-tutor-jump');
    const plan = await w.startedPlan();
    await w.submit(plan, 1, w.employee.userId);
    const { instance, task } = await w.pendingTask(plan, 1, w.manager.userId);
    const jumped = await taskPost(w, w.manager.userId, task.id, 'jump', instance.revision, { toNodeKey: 'set_goals' });
    expect(jumped.status, await jumped.clone().text()).toBe(200);
    expect(await pendingOf(w, plan)).toEqual([
      expect.objectContaining({ nodeKey: 'set_goals', assigneeUserId: w.employee.userId }),
    ]);
  });

  it('指导人驳回（到发起人）：实例退回，阶段仍进行中；所有者重提后从员工节点重新开始', async () => {
    const w = await world('idp-k39-reject');
    const plan = await w.startedPlan();
    await w.submit(plan, 1, w.employee.userId);
    const { instance, task } = await w.pendingTask(plan, 1, w.manager.userId);
    const rejected = await taskPost(w, w.manager.userId, task.id, 'reject', instance.revision, { comment: '重做' });
    expect(rejected.status, await rejected.clone().text()).toBe(200);
    const returned = await w.instanceOf(plan, 1);
    expect(returned.status).toBe('returned');
    expect((await w.readPlan(plan.id)).stages[0]!.status).toBe('running');
    expect((await w.detail(returned.id, w.hrUser)).actions).toContain('resubmit');
    const again = await w.http(w.hrUser, 'POST', `${APV}/instances/${returned.id}/resubmit`, {
      ifMatch: returned.revision,
    });
    expect(again.status, await again.clone().text()).toBe(200);
    expect(await pendingOf(w, plan)).toEqual([
      expect.objectContaining({ nodeKey: 'set_goals', assigneeUserId: w.employee.userId }),
    ]);
  });

  it('撤回：预置关闭 409；节点打开 revoke 时所有者可撤回、撤回后可重提', async () => {
    const off = await world('idp-k39-revoke-off');
    const offPlan = await off.startedPlan();
    const offInstance = await off.instanceOf(offPlan, 1);
    const denied = await off.http(off.hrUser, 'POST', `${APV}/instances/${offInstance.id}/withdraw`, {
      ifMatch: offInstance.revision,
    });
    expect(await errorOf(denied)).toMatchObject({ status: 409, reason: 'APPROVAL_ACTION_DISABLED' });

    const on = await world('idp-k39-revoke-on', { revoke: true });
    const plan = await on.startedPlan();
    const instance = await on.instanceOf(plan, 1);
    expect((await on.detail(instance.id, on.hrUser)).actions).toContain('withdraw');
    const withdrawn = await on.http(on.hrUser, 'POST', `${APV}/instances/${instance.id}/withdraw`, {
      ifMatch: instance.revision,
    });
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    const after = await on.instanceOf(plan, 1);
    expect(after.status).toBe('withdrawn');
    const again = await on.http(on.hrUser, 'POST', `${APV}/instances/${after.id}/resubmit`, {
      ifMatch: after.revision,
    });
    expect(again.status, await again.clone().text()).toBe(200);
    expect((await on.instanceOf(plan, 1)).status).toBe('running');
  });

  it('审批中编辑：预置节点 editMode = none，审批中心编辑 409（内容按 IDP 节点按钮维护）', async () => {
    const w = await world('idp-k39-edit');
    const plan = await w.startedPlan();
    const { instance, task } = await w.pendingTask(plan, 1, w.employee.userId);
    const edited = await taskPost(w, w.employee.userId, task.id, 'edit', instance.revision, { fields: { name: 'x' } });
    expect(edited.status).toBe(409);
    expect((await w.detail(instance.id, w.employee.userId)).actions).not.toContain('edit');
  });
});
