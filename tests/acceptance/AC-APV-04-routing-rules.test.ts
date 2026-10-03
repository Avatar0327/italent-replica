/**
 * PR #35 第二轮清单 主题 C：路由规则。
 * 6 中间节点审批人为空一律转异常管理员（DEC-054）；15 异常管理员本人回避（DEC-091）；16 管理员不得干预本人
 * 实例（DEC-092）；17 改了条件字段的重提重新匹配（DEC-093）；19 兜底排尾、同优先级禁止发布（DEC-096）；
 * 21 无可用账号按空处理、异常管理员停用前交接、在途异常任务由租户管理员接管（DEC-098）；
 * X-14 自动同意触发同意消息；C-非3 被自审跳过的人不因此成为参与人。
 */
import { revokeMembership, sql, withTenant } from '@italent/db';
import { bootstrapTenantAdmin } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, transferScene, type InstanceView } from './AC-APV-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { code: string; details?: { reason?: string } } };
  return { status: response.status, reason: body.error?.details?.reason };
}

async function membershipRevision(w: Awaited<ReturnType<typeof approvalWorld>>, userId: string) {
  const rows = await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`SELECT revision FROM tenant_memberships WHERE tenant_id=${w.tenant.id} AND user_id=${userId}::uuid`),
  );
  const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as { revision: number }[];
  return Number(list[0]!.revision);
}

describe('清单 6：中间节点审批人为空一律转异常管理员（DEC-054）', () => {
  it('不再接受“自动跳过 / 自动同意”配置', async () => {
    const w = await approvalWorld(database().db, 'apv-no-assignee-policy');
    for (const noAssignee of ['skip', 'approve'] as const) {
      const response = await w.request(w.hr.id, 'POST', `${BASE}/processes`, {
        ifMatch: 0,
        body: {
          code: `P_${noAssignee}`,
          name: '合成流程',
          approvalType: 'transfer',
          exceptionAdminUserId: w.hr.id,
          conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
          nodes: [{ key: 'in_hrbp', approver: 'record_department_hrbp', noAssignee }],
        },
      });
      expect(response.status).toBe(400);
    }
  });
});

describe('清单 15：异常管理员恰为发起人或异动本人时回避（DEC-091）', () => {
  it('异常管理员是发起人且无有效直线经理：拒绝提交，申请保持草稿', async () => {
    const w = await approvalWorld(database().db, 'apv-admin-self-reject');
    const s = await transferScene(w);
    await w.publishedProcess({ exceptionAdminUserId: w.hr.id, nodes: TRANSFER_NODES });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const response = await w.submitRaw(draft);
    expect(await reasonOf(response)).toMatchObject({ status: 409, reason: 'APPROVAL_EXCEPTION_ADMIN_SELF' });
    expect(await w.business(draft.id)).toMatchObject({ status: 'draft' });
  });

  it('异常管理员是发起人且有直线经理：异常任务改派给其直线经理', async () => {
    const w = await approvalWorld(database().db, 'apv-admin-self-manager');
    const s = await transferScene(w);
    const initiator = await w.person('发起 HR', s.from, { directManagerId: s.manager.employeeId });
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ exceptionAdminUserId: initiator.userId, nodes: TRANSFER_NODES.slice(0, 2) });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: initiator.userId });
    let view = await w.submit(draft, initiator.userId);
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({
      nodeKey: 'in_hrbp',
      assigneeUserId: s.manager.userId,
      isExceptionAdmin: true,
    });
  });
});

describe('清单 16：管理员不得干预本人发起或本人为异动对象的实例（DEC-092）', () => {
  it('发起人本人的管理员改派 / 跳转被拒；其他管理员可以处理', async () => {
    const w = await approvalWorld(database().db, 'apv-admin-own');
    const s = await transferScene(w);
    const other = await w.member('其他管理员');
    await w.publishedProcess({ exceptionAdminUserId: other, nodes: TRANSFER_NODES });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const body = { kind: 'reassign', taskId: current(view).id, toUserId: s.inHead.userId, reason: '自己改派' };
    const own = await w.instanceAction(w.hr.id, view.id, 'admin-intervene', view.revision, body);
    expect(await reasonOf(own)).toMatchObject({ status: 403, reason: 'APPROVAL_ADMIN_SELF' });
    const jump = await w.instanceAction(w.hr.id, view.id, 'admin-intervene', view.revision, {
      kind: 'jump',
      toNodeKey: 'in_head',
      reason: '自己跳转',
    });
    expect(await reasonOf(jump)).toMatchObject({ status: 403, reason: 'APPROVAL_ADMIN_SELF' });
    const ok = await w.instanceAction(other, view.id, 'admin-intervene', view.revision, body);
    expect(ok.status, await ok.clone().text()).toBe(200);
  });
});

describe('清单 17：驳回后改了发起条件字段的重提重新匹配流程（DEC-093）', () => {
  it('命中不同流程：旧实例作废、新开实例，单据与历史保留；只改非条件字段则同单重提', async () => {
    const w = await approvalWorld(database().db, 'apv-rematch');
    const s = await transferScene(w);
    const other = await w.org('另一调入部门');
    const otherHead = await w.person('另一调入负责人', other);
    await w.setOrgRoles(other, { head: otherHead.employeeId });
    const byDepartment = (code: string, priority: number, org: string) =>
      w.publishedProcess({
        code,
        priority,
        conditions: { items: [{ no: 1, field: 'record.departmentId', operator: 'in_org_tree', value: org }] },
        nodes: [{ key: 'in_head', approver: 'record_department_head' }],
      });
    const first = await byDepartment('BY_TO', 1, s.to);
    const second = await byDepartment('BY_OTHER', 2, other);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to, place: '旧地点' });
    let view = await w.submit(draft);
    expect(view.processId).toBe(first.id);
    view = await w.json(await w.taskAction(s.inHead.userId, current(view).id, 'reject', view.revision));
    const patch = async (fields: Record<string, unknown>) => {
      const business = await w.business(draft.id);
      return w.json<{ revision: number }>(
        await w.request(w.hr.id, 'PATCH', `/api/tenant/employment/businesses/${draft.id}`, {
          ifMatch: business.revision,
          body: { fields },
        }),
      );
    };
    let patched = await patch({ place: '新地点' });
    await w.json(await w.submitRaw({ id: draft.id, revision: patched.revision }));
    const same = await w.detail(view.id);
    expect(same).toMatchObject({ status: 'running', processId: first.id });
    await w.json(await w.taskAction(s.inHead.userId, current(same).id, 'reject', same.revision));
    patched = await patch({ departmentId: other });
    await w.json(await w.submitRaw({ id: draft.id, revision: patched.revision }));
    const old = await w.detail(view.id);
    expect(old.status).toBe('cancelled');
    expect(old.logs).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'rematch' })]));
    const fresh = await w.instanceOfAll(draft.id);
    const active = fresh.find((item) => item.status === 'running')!;
    expect(active.processId).toBe(second.id);
    expect(current(active)).toMatchObject({ assigneeUserId: otherHead.userId });
  });
});

describe('清单 19：兜底流程排在最后；同类型普通流程优先级相同禁止发布（DEC-096）', () => {
  it('同类型同优先级的普通流程发布被拒；兜底流程与不同类型不受限', async () => {
    const w = await approvalWorld(database().db, 'apv-priority-tie');
    await w.publishedProcess({ code: 'TIE_A', priority: 5, nodes: TRANSFER_NODES });
    const tie = await w.createProcess({ code: 'TIE_B', priority: 5, nodes: TRANSFER_NODES });
    const rejected = await w.request(w.hr.id, 'POST', `${BASE}/processes/${tie.id}/publish`, {
      ifMatch: tie.revision,
    });
    expect(await reasonOf(rejected)).toMatchObject({ status: 409, reason: 'APPROVAL_PRIORITY_DUPLICATE' });
    await w.publishedProcess({
      code: 'TIE_FALLBACK',
      priority: 5,
      isFallback: true,
      conditions: { items: [] },
      nodes: TRANSFER_NODES,
    });
    await w.publishedProcess({
      code: 'TIE_LEAVE',
      approvalType: 'leave',
      priority: 5,
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] },
      nodes: TRANSFER_NODES,
    });
  });
});

describe('清单 21：无可用账号按空处理；异常管理员停用前交接；在途异常任务由租户管理员接管（DEC-098）', () => {
  it('解析到的人员没有可用账号：中间节点按空处理转异常管理员', async () => {
    const w = await approvalWorld(database().db, 'apv-no-account');
    const s = await transferScene(w);
    const admin = await w.member('异常管理员');
    const unbound = await w.employee('没有账号的 HRBP');
    await w.hire(unbound.id, { departmentId: s.to });
    await w.setOrgRoles(s.to, { hrbp: unbound.id });
    await w.publishedProcess({ exceptionAdminUserId: admin, nodes: TRANSFER_NODES.slice(0, 2) });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ nodeKey: 'in_hrbp', assigneeUserId: admin, isExceptionAdmin: true });
  });

  it('异常管理员停用前必须交接；交接后在途单的异常任务由租户管理员接管', async () => {
    const w = await approvalWorld(database().db, 'apv-admin-handover');
    const s = await transferScene(w);
    await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
    const leaving = await w.member('将离职的异常管理员');
    const successor = await w.member('接任的异常管理员');
    await w.setOrgRoles(s.to, { hrbp: null });
    const process = await w.publishedProcess({ exceptionAdminUserId: leaving, nodes: TRANSFER_NODES.slice(0, 2) });
    // 发起人不是租户管理员，否则接管人按 DEC-091 还要回避。
    const applicant = await w.member('发起人');
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: applicant });
    const view = await w.submit(draft, applicant);
    const revision = await membershipRevision(w, leaving);
    const blocked = await revokeMembership(
      w.db,
      { tenantId: w.tenant.id, userId: leaving, expectedRevision: revision },
      cmd(),
    ).catch((error: unknown) => error as { message: string; cause?: { message?: string } });
    expect(String((blocked as { cause?: { message?: string } }).cause?.message ?? blocked)).toContain('异常管理员');
    const handover = await w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
      ifMatch: 0,
      body: { fromUserId: leaving, toUserId: successor },
    });
    expect(handover.status, await handover.clone().text()).toBe(200);
    const reloaded = await w.json<{ currentVersion: { exceptionAdminUserId: string; versionNo: number } }>(
      await w.request(w.hr.id, 'GET', `${BASE}/processes/${process.id}`),
    );
    expect(reloaded.currentVersion).toMatchObject({ exceptionAdminUserId: successor, versionNo: 2 });
    await revokeMembership(w.db, { tenantId: w.tenant.id, userId: leaving, expectedRevision: revision }, cmd());
    const before = await w.detail(view.id, applicant);
    const after = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(before).id, 'approve', before.revision),
    );
    // 在途实例冻结在旧版本，旧异常管理员已停用：异常任务由租户管理员接管。
    expect(current(after)).toMatchObject({ nodeKey: 'in_hrbp', assigneeUserId: w.hr.id, isExceptionAdmin: true });
  });

  it('C-非5：派单前复核成员身份——发起人已停用时“流程所有者”节点按空处理', async () => {
    const w = await approvalWorld(database().db, 'apv-owner-revoked');
    const s = await transferScene(w);
    const initiator = await w.member('离职的发起人');
    await w.publishedProcess({
      exceptionAdminUserId: w.hr.id,
      nodes: [TRANSFER_NODES[0]!, { key: 'owner', approver: 'owner' }],
    });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: initiator });
    const view = await w.submit(draft, initiator);
    const revision = await membershipRevision(w, initiator);
    await revokeMembership(w.db, { tenantId: w.tenant.id, userId: initiator, expectedRevision: revision }, cmd());
    const after = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision),
    );
    expect(current(after)).toMatchObject({ nodeKey: 'owner', assigneeUserId: w.hr.id, isExceptionAdmin: true });
    // 已停用的账号不是可审批的人：按“审批人为空”处理，不产生对其的自审跳过记录。
    expect(after.tasks.some((task) => task.nodeKey === 'owner' && task.origin === 'self_skip')).toBe(false);
  });
});

describe('X-14：自动同意也触发该节点的同意消息规则', () => {
  it('与上一节点同人自动同意时，按消息规则通知异动员工', async () => {
    const w = await approvalWorld(database().db, 'apv-auto-message');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { head: s.outHead.employeeId });
    await w.publishedProcess({
      nodes: [
        TRANSFER_NODES[0]!,
        {
          key: 'in_head',
          approver: 'record_department_head',
          sameAssigneeSkip: true,
          messageRules: [
            { trigger: 'approve', channels: ['inbox'], template: 'TenantBase.Ygddtz', recipient: 'subject_employee' },
          ],
        },
      ],
    });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const done = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision),
    );
    expect(done.status).toBe('approved');
    const inbox = await w.json<{ items: { kind: string; template: string | null }[] }>(
      await w.request(s.subject.userId, 'GET', `${BASE}/notifications`),
    );
    expect(inbox.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'message', template: 'TenantBase.Ygddtz' })]),
    );
  });
});

describe('C-非3：被自审跳过的人不因此成为参与人', () => {
  it('异动本人恰为首节点审批人：自审跳过后看不到该实例，参与列表也不含它', async () => {
    const w = await approvalWorld(database().db, 'apv-self-skip-visibility');
    const s = await transferScene(w);
    await w.setOrgRoles(s.from, { head: s.subject.employeeId });
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(view.tasks.find((task) => task.origin === 'self_skip')).toMatchObject({ assigneeUserId: s.subject.userId });
    // 用不含审批管理员按钮的授权器，排除“范围内管理员可看详情”的另一条通道。
    const plain = tenantApi(w.db, {
      clock: w.clock,
      authorize: (request) =>
        !(request.action === 'object.button' && /ApprovalInstance/.test(String(request.resource))),
    });
    const opened = await plain.request('GET', `${BASE}/instances/${view.id}`, w.as(s.subject.userId));
    expect(opened.status).toBe(404);
    const participated = await w.json<{ items: { id: string }[] }>(
      await w.request(s.subject.userId, 'GET', `${BASE}/instances?role=participated`),
    );
    expect(participated.items.map((item) => item.id)).not.toContain(view.id);
  });
});
