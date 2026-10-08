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

  it('员工节点打开回避后，即使把待办转到员工本人，办理也按自审拒绝（开关同时管办理时的拦截）', async () => {
    const w = await planWorld(testDb().db, 'idp-k37-act', {
      nodes: { idp_employee: { actions: { avoidSelf: true } }, idp_tutor: { actions: { avoidSelf: false } } },
    });
    const plan = await w.startedPlan();
    const instance = await w.instanceOf(plan, 1);
    const task = instance.tasks.find((t) => t.status === 'pending')!;
    // 全权管理员（非发起人）把待办改派给员工本人
    const admin = await w.member('改派管理员');
    await w.ok(
      await w.http(admin, 'POST', `/api/tenant/approval/instances/${instance.id}/admin-intervene`, {
        ifMatch: instance.revision,
        body: { taskId: task.id, toUserId: w.employee.userId, reason: '测试改派' },
      }),
    );
    expect(await errorOf(await w.submitRaw(plan, 1, w.employee.userId))).toMatchObject({ status: 409 });
  });

  it('其他审批类型不配置开关：保持现状，异动本人仍被自审跳过，读回定义不含 avoidSelf', async () => {
    const w = await approvalWorld(testDb().db, 'idp-k37-regress');
    const s = await transferScene(w);
    // 员工本人恰为调出部门负责人：第一个节点解析到本人 → 自审跳过转其直线经理
    await w.setOrgRoles(s.from, { head: s.subject.employeeId });
    const process = await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    expect(process.currentVersion!.nodes[0]!.actions).not.toHaveProperty('avoidSelf');
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(current(view)).toMatchObject({ assigneeUserId: s.manager.userId, origin: 'self_skip_manager' });
  });
});
