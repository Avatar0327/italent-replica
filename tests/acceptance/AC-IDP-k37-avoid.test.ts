/**
 * DEC-318 K-37：自审回避（发起人 / 异动本人不审批自己的单据：路由时自审跳过、办理时拒绝）是审批节点上的开关
 * actions.avoidSelf，不按 idp_employee 表达式写死例外。
 * - IDP 预置流程：两个节点的回避、加签、转交、抄送全部关闭 → 员工处理自己计划的节点是正常路径；
 * - 开关打开（avoidSelf: true）时，IDP 员工节点同样回避：员工是异动本人，被自审跳过、转其直线经理；
 * - 其他审批类型没有配置开关时保持现状（缺省开启），读回的节点定义也不出现该键（不退化）。
 */
import { PRESET_PROCESSES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, type InstanceView, TRANSFER_NODES, transferScene } from './AC-APV-support.js';
import { errorOf, planWorld } from './AC-IDP-plan-support.js';
import { dropFrozen } from './support/f048.js';

const testDb = useTestDb();
const current = (view: InstanceView) => view.tasks.find((t) => t.status === 'pending')!;

describe('K-37：回避是节点开关', () => {
  it('IDP 预置流程：回避、加签、转交、抄送全部关闭', () => {
    for (const type of ['idp_plan', 'idp_mid_review', 'idp_final_review']) {
      const preset = PRESET_PROCESSES.find((p) => p.approvalType === type)!;
      for (const node of preset.definition.nodes) {
        expect(node.actions, `${type}/${node.key}`).toMatchObject({
          avoidSelf: false,
          addSign: false,
          transfer: false,
          copySend: false,
        });
      }
    }
  });

  it('IDP 员工节点打开回避：员工（异动本人）被自审跳过，转其直线经理；关闭时员工本人办理', async () => {
    const on = await planWorld(testDb().db, 'idp-k37-on', {
      nodes: { idp_employee: { actions: { avoidSelf: true } }, idp_tutor: { actions: { avoidSelf: false } } },
    });
    const plan = await on.startedPlan();
    const pending = (await on.instanceOf(plan, 1)).tasks.filter((t) => t.status === 'pending');
    expect(pending).toEqual([
      expect.objectContaining({ nodeKey: 'set_goals', assigneeUserId: on.manager.userId, origin: 'self_skip_manager' }),
    ]);

    const off = await planWorld(testDb().db, 'idp-k37-off');
    const offPlan = await off.startedPlan();
    const task = (await off.instanceOf(offPlan, 1)).tasks.find((t) => t.status === 'pending')!;
    expect(task).toMatchObject({ assigneeUserId: off.employee.userId, origin: 'resolved' });
    await off.submit(offPlan, 1, off.employee.userId);
  });

  it('员工节点打开回避：管理员也不能把待办改派给员工本人（开关同时管转交 / 改派目标）', async () => {
    const w = await planWorld(testDb().db, 'idp-k37-act', {
      nodes: { idp_employee: { actions: { avoidSelf: true } }, idp_tutor: { actions: { avoidSelf: false } } },
    });
    const plan = await w.startedPlan();
    const instance = await w.instanceOf(plan, 1);
    const task = instance.tasks.find((t) => t.status === 'pending')!;
    const admin = await w.member('改派管理员');
    const reassigned = await w.http(admin, 'POST', `/api/tenant/approval/instances/${instance.id}/admin-intervene`, {
      ifMatch: instance.revision,
      body: { taskId: task.id, toUserId: w.employee.userId, reason: '测试改派' },
    });
    expect(await errorOf(reassigned)).toMatchObject({ status: 409, reason: 'APPROVAL_SELF_REVIEW' });
  });

  // F-048 PR-1（DEC-329④）：新建节点缺省改为关闭，回显改为始终显式；夹具 createProcess 不给时显式发送 true，
  // 缺省关闭本身见 AC-APV-F048-defaults（T11）。
  it('其他审批类型开启自审回避：异动本人仍被自审跳过，读回定义显式 avoidSelf=true', async () => {
    const w = await approvalWorld(testDb().db, 'idp-k37-regress');
    const s = await transferScene(w);
    // 员工本人恰为调出部门负责人：第一个节点解析到本人 → 自审跳过转其直线经理
    await w.setOrgRoles(s.from, { head: s.subject.employeeId });
    const process = await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    expect(process.currentVersion!.nodes[0]!.actions).toMatchObject({ avoidSelf: true, avoidSubjects: false });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(current(view)).toMatchObject({ assigneeUserId: s.manager.userId, origin: 'self_skip_manager' });
  });
});

describe('F-048 T11 IDP：缺省关闭与存量在途实例', () => {
  it('手工新建且不传开关：员工节点由员工本人收到待办（缺省关闭，不被自审回避）', async () => {
    const w = await planWorld(testDb().db, 'idp-f048-default', {
      nodes: { idp_employee: { actions: { avoidSelf: undefined } }, idp_tutor: { actions: { avoidSelf: undefined } } },
    });
    const plan = await w.startedPlan();
    const task = (await w.instanceOf(plan, 1)).tasks.find((t) => t.status === 'pending')!;
    expect(task).toMatchObject({ assigneeUserId: w.employee.userId, origin: 'resolved' });
  });

  it('存量在途实例（无冻结行）：员工节点升级后继续办理，提交后进入指导人节点', async () => {
    const w = await planWorld(testDb().db, 'idp-f048-legacy');
    const plan = await w.startedPlan();
    await dropFrozen(w.db, w.tenant.id, (await w.instanceOf(plan, 1)).id);
    await w.submit(plan, 1, w.employee.userId);
    const next = (await w.instanceOf(plan, 1)).tasks.find((t) => t.status === 'pending')!;
    expect(next).toMatchObject({ nodeKey: 'approve_plan', assigneeUserId: w.manager.userId });
  });
});
