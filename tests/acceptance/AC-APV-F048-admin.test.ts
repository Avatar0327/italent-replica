/**
 * F-048 PR-2 实例级回避（设计 §2.4、§6 #2、#7、#17～#19，测试 T5、T6）：
 * - 管理员兼集合内主体（不只是单主体）→ 403 APPROVAL_ADMIN_SELF（DEC-092 扩到全部主体，DEC-329②）；
 * - 管理员改派目标是主体 → 409 APPROVAL_SELF_REVIEW（节点开启 avoidSubjects）；
 * - 异常管理员是集合内主体 → 转其直线经理；无可接替的直线经理时提交预检 409，实例不建（DEC-091）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';
import { bind, NODES, pendingOf, reasonOf, snapshotOf, useSubjectMapping } from './support/f048.js';

const database = useTestDb();
const mapSubjects = useSubjectMapping();

async function adminScene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({ nodes: [{ ...NODES.outHead, actions: { avoidSubjects: true } }, NODES.inHrbp] });
  return { w, s };
}

const submitted = async (w: ApprovalWorld, s: Awaited<ReturnType<typeof transferScene>>) =>
  w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));

describe('T5 管理员干预 / 转交：操作人是集合内主体 → 403（DEC-092 / DEC-329②）', () => {
  it('集合内的非单主体成员（冻结账号）做管理员转交 / 干预 → 403 APPROVAL_ADMIN_SELF，前后一致；无关管理员可处理', async () => {
    const { w, s } = await adminScene('f048-adm-member');
    const subjectAdmin = await w.employee('集合成员管理员');
    const adminUser = await bind(w, subjectAdmin.id, '集合成员管理员账号');
    mapSubjects(() => [subjectAdmin.id]);
    const view = await submitted(w, s);
    const task = pendingOf(view)[0]!;
    const before = await snapshotOf(w, view.id);
    const body = { taskId: task.id, toUserId: s.inHead.userId, reason: '改派' };
    for (const action of ['admin-transfer', 'admin-intervene'] as const) {
      const response = await w.instanceAction(adminUser, view.id, action, view.revision, {
        ...body,
        ...(action === 'admin-intervene' ? { kind: 'reassign' } : {}),
      });
      expect(await reasonOf(response), action).toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
        reason: 'APPROVAL_ADMIN_SELF',
      });
    }
    expect(await snapshotOf(w, view.id)).toEqual(before);
    const other = await w.member('无关管理员');
    const ok = await w.instanceAction(other, view.id, 'admin-transfer', view.revision, body);
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it('管理员改派的目标是主体（账号在冻结 U(S) 中）→ 409 APPROVAL_SELF_REVIEW，任务不动', async () => {
    const { w, s } = await adminScene('f048-adm-target');
    mapSubjects(() => [s.inHead.employeeId]);
    const view = await submitted(w, s);
    const other = await w.member('无关管理员');
    const before = await snapshotOf(w, view.id);
    for (const [action, extra] of [
      ['admin-transfer', {}],
      ['admin-intervene', { kind: 'reassign' }],
    ] as const) {
      const response = await w.instanceAction(other, view.id, action, view.revision, {
        taskId: pendingOf(view)[0]!.id,
        toUserId: s.inHead.userId,
        reason: '改派给主体',
        ...extra,
      });
      expect(await reasonOf(response), action).toMatchObject({
        status: 409,
        reason: 'APPROVAL_SELF_REVIEW',
        recusal: 'subjects',
      });
    }
    expect(await snapshotOf(w, view.id)).toEqual(before);
  });

  it('管理员跳转后重新路由：目标节点的审批人是冻结的主体 → 出现 subject_skip，流转到下一节点；冻结后改映射不影响', async () => {
    const w = await approvalWorld(database().db, 'f048-adm-jump');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [NODES.outHead, { ...NODES.inHrbp, actions: { avoidSubjects: true } }, NODES.inHead],
    });
    mapSubjects(() => [s.inHrbp.employeeId]);
    const view = await submitted(w, s);
    const other = await w.member('无关管理员');
    // 冻结后适配器映射再变，也不影响本轮：跳转用的仍是发起时冻结的 S
    mapSubjects(() => []);
    const jumped = await w.json<InstanceView>(
      await w.instanceAction(other, view.id, 'admin-intervene', view.revision, {
        kind: 'jump',
        toNodeKey: 'in_hrbp',
        reason: '跳转',
      }),
    );
    expect(jumped.tasks.find((task) => task.nodeKey === 'in_hrbp')).toMatchObject({ origin: 'subject_skip' });
    expect(pendingOf(jumped)).toEqual([expect.objectContaining({ nodeKey: 'in_head' })]);
  });
});

describe('T6 异常管理员是集合内主体：转其直线经理 / 提交预检 409（DEC-092 / DEC-329②）', () => {
  async function exceptionScene(label: string, withManager: boolean) {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    const adminManager = await w.person('异常管理员的经理', s.from);
    const admin = await w.person('异常管理员', s.from, withManager ? { directManagerId: adminManager.employeeId } : {});
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ exceptionAdminUserId: admin.userId, nodes: [NODES.outHead, NODES.inHrbp] });
    mapSubjects(() => [admin.employeeId]);
    return { w, s, admin, adminManager };
  }

  it('审批人为空转异常管理员；异常管理员是主体 → 转其直线经理', async () => {
    const { w, s, adminManager } = await exceptionScene('f048-exc-manager', true);
    let view = await submitted(w, s);
    view = await w.json(await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision));
    expect(pendingOf(view)).toEqual([
      expect.objectContaining({ nodeKey: 'in_hrbp', assigneeUserId: adminManager.userId, isExceptionAdmin: true }),
    ]);
  });

  it('异常管理员是主体且没有可接替的直线经理：提交预检 409 APPROVAL_EXCEPTION_ADMIN_SELF，实例与业务单不动', async () => {
    const { w, s } = await exceptionScene('f048-exc-precheck', false);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const before = await w.business(draft.id);
    const response = await w.submitRaw(draft);
    expect(await reasonOf(response)).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      reason: 'APPROVAL_EXCEPTION_ADMIN_SELF',
    });
    expect(await w.business(draft.id)).toMatchObject({ status: before.status, revision: before.revision });
    const list = await w.json<{ items: unknown[] }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/approval/instances?role=initiated&businessId=${draft.id}`),
    );
    expect(list.items).toEqual([]);
  });
});
