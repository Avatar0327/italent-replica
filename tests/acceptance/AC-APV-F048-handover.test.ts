/**
 * F-048 PR-2 交接 / 停用接管与救援动作（设计 §6 #22～#24、§7.1，测试 T7）：
 * 操作人、替代人、接管替代人按实例级 I 判定（全部主体）；救援动作（发起人撤回、管理员改派给显式 W、交接只跳过该单）
 * 不被前置的自动路由挡住。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { permissionUserPersonLinks, revokeMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';
import { NODES, pendingOf, reasonOf, rowsOf, snapshotOf, useSubjectMapping } from './support/f048.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const mapSubjects = useSubjectMapping();
const BASE = '/api/tenant/approval';

/** 第二个节点 HRBP 为空 → 异常管理员待办；发起人是独立的 init（HR 不是发起人，便于让 HR 作为交接操作人）。 */
async function exceptionInstance(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  const init = await w.person('发起人', s.from, { directManagerId: s.manager.employeeId });
  await w.setOrgRoles(s.to, { hrbp: null });
  await w.publishedProcess({ nodes: [NODES.outHead, NODES.inHrbp] });
  return { w, s, init };
}

async function reachException(
  w: ApprovalWorld,
  s: Awaited<ReturnType<typeof transferScene>>,
  init: { userId: string },
) {
  const draft = await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: init.userId });
  let view = await w.submit(draft, init.userId);
  view = await w.json(await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision));
  expect(pendingOf(view)).toEqual([
    expect.objectContaining({ assigneeUserId: w.exceptionAdmin, isExceptionAdmin: true }),
  ]);
  return view;
}

type Handover = { tasks: number; skipped: { instanceId: string; reason: string }[] };
const handover = (w: ApprovalWorld, operator: string, toUserId: string) =>
  w.request(operator, 'POST', `${BASE}/exception-admins/handover`, {
    ifMatch: 0,
    body: { fromUserId: w.exceptionAdmin, toUserId },
  });

describe('T7 交接', () => {
  it('操作人是集合内主体（非发起人）→ 该单 skipped APPROVAL_ADMIN_SELF，任务不动', async () => {
    const { w, s, init } = await exceptionInstance('f048-ho-operator');
    const hrEmployee = await w.employee('操作人对应员工');
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx
        .insert(permissionUserPersonLinks)
        .values({ tenantId: w.tenant.id, userId: w.hr.id, employeeId: hrEmployee.id }),
    );
    mapSubjects(() => [hrEmployee.id]);
    const view = await reachException(w, s, init);
    const before = await snapshotOf(w, view.id, init.userId);
    const successor = await w.member('替代人');
    const result = await w.json<Handover>(await handover(w, w.hr.id, successor));
    expect(result).toMatchObject({ tasks: 0, skipped: [{ instanceId: view.id, reason: 'APPROVAL_ADMIN_SELF' }] });
    expect(await snapshotOf(w, view.id, init.userId)).toEqual(before);
  });

  it('替代人是集合内主体：有直线经理 → 转其经理；没有 → 该单 skipped APPROVAL_EXCEPTION_ADMIN_SELF', async () => {
    const withManager = await exceptionInstance('f048-ho-successor-manager');
    const mgr = await withManager.w.person('替代人的经理', withManager.s.from);
    const successor = await withManager.w.person('替代人', withManager.s.from, { directManagerId: mgr.employeeId });
    mapSubjects(() => [successor.employeeId]);
    const view = await reachException(withManager.w, withManager.s, withManager.init);
    const done = await withManager.w.json<Handover>(
      await handover(withManager.w, withManager.w.hr.id, successor.userId),
    );
    expect(done.tasks).toBe(1);
    expect(pendingOf(await withManager.w.detail(view.id, withManager.init.userId))).toEqual([
      expect.objectContaining({ assigneeUserId: mgr.userId, isExceptionAdmin: true }),
    ]);

    const alone = await exceptionInstance('f048-ho-successor-alone');
    const lone = await alone.w.person('无经理的替代人', alone.s.from);
    mapSubjects(() => [lone.employeeId]);
    const stuck = await reachException(alone.w, alone.s, alone.init);
    const before = await snapshotOf(alone.w, stuck.id, alone.init.userId);
    const skipped = await alone.w.json<Handover>(await handover(alone.w, alone.w.hr.id, lone.userId));
    expect(skipped).toMatchObject({
      tasks: 0,
      skipped: [{ instanceId: stuck.id, reason: 'APPROVAL_EXCEPTION_ADMIN_SELF' }],
    });
    expect(await snapshotOf(alone.w, stuck.id, alone.init.userId)).toEqual(before);
  });

  it('停用接管：指定的替代人是集合内主体 → 回退租户管理员', async () => {
    const { w, s, init } = await exceptionInstance('f048-ho-takeover');
    await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
    const successor = await w.person('替代人', s.from);
    mapSubjects(() => [successor.employeeId]);
    const view = await reachException(w, s, init);
    await w.json<Handover>(await handover(w, w.hr.id, successor.userId)); // 登记替代人（本单因替代人回避被跳过）
    const rows = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT revision FROM tenant_memberships WHERE tenant_id=${w.tenant.id}
        AND user_id=${w.exceptionAdmin}::uuid`),
    );
    await revokeMembership(
      w.db,
      {
        tenantId: w.tenant.id,
        userId: w.exceptionAdmin,
        expectedRevision: Number(rowsOf<{ revision: number }>(rows)[0]!.revision),
      },
      cmd(),
    );
    expect(pendingOf(await w.detail(view.id, init.userId))).toEqual([
      expect.objectContaining({ assigneeUserId: w.hr.id, isExceptionAdmin: true }),
    ]);
  });
});

describe('T7 救援（R2-03）：路由失败时救援动作仍可用', () => {
  it('下一节点异常管理员命中且直线经理已离职：人工同意 409 整单回滚；撤回、改派给显式 W、交接都成功', async () => {
    const w = await approvalWorld(database().db, 'f048-ho-rescue');
    const s = await transferScene(w);
    const init = await w.person('发起人', s.from, { directManagerId: s.manager.employeeId });
    const adminManager = await w.person('异常管理员的经理', s.from);
    const admin = await w.person('异常管理员', s.from, { directManagerId: adminManager.employeeId });
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ exceptionAdminUserId: admin.userId, nodes: [NODES.outHead, NODES.inHrbp] });
    mapSubjects(() => [admin.employeeId]);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: init.userId });
    const view = await w.submit(draft, init.userId);
    // 提交后直线经理离职生效：下一节点转异常管理员时，异常管理员（主体）已无可接替的经理
    const manager = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${adminManager.employeeId}`),
    );
    await w.json(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${adminManager.employeeId}/businesses`, {
        ifMatch: manager.revision,
        body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-01', fields: {} },
      }),
      201,
    );
    const before = await snapshotOf(w, view.id, init.userId);
    const approve = await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision);
    expect(await reasonOf(approve)).toMatchObject({ status: 409, reason: 'APPROVAL_EXCEPTION_ADMIN_SELF' });
    expect(await snapshotOf(w, view.id, init.userId)).toEqual(before);
    // 救援一：管理员把在办任务改派给显式指定的 W
    const other = await w.member('流程管理员');
    const reassigned = await w.json<InstanceView>(
      await w.instanceAction(other, view.id, 'admin-intervene', view.revision, {
        kind: 'reassign',
        taskId: pendingOf(view)[0]!.id,
        toUserId: s.inHead.userId,
        reason: '救援',
      }),
    );
    expect(pendingOf(reassigned)).toEqual([expect.objectContaining({ assigneeUserId: s.inHead.userId })]);
    // 救援二：发起人撤回
    const withdrawn = await w.json<InstanceView>(
      await w.instanceAction(init.userId, view.id, 'withdraw', reassigned.revision),
    );
    expect(withdrawn.status).toBe('withdrawn');
    // 救援三：交接只跳过该单、不报错
    const result = await w.json<Handover>(await handover(w, w.hr.id, other));
    expect(result.tasks).toBe(0);
  });
});
