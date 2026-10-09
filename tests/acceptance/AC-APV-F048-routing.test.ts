/**
 * F-048 PR-2 路由判定（docs/08_设计/F-048_审批多主体回避_设计.md §2.3、§3.1、§7.1，测试 T2、T3、T9c、T14）：
 * 单人节点 avoidSubjects 命中冻结的 S / U(S) → 自动「跳过」（subject_skip，处理人系统、不计同意、无盲审）；
 * avoidSelf 先于 avoidSubjects；owner 候选只按账号比较；会签或无「同意」出口的节点开启 → 400；
 * subject_skip 属系统处理，不阻断前一节点审批人撤回（R2-04）。
 */
import { eq, permissionUserPersonLinks, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';
import { NODES, pendingOf, reasonOf, useSubjectMapping } from './support/f048.js';

const database = useTestDb();
const mapSubjects = useSubjectMapping();
const BASE = '/api/tenant/approval';
const ON = { avoidSubjects: true } as const;

async function approveCurrent(w: ApprovalWorld, view: InstanceView, actor: string) {
  return w.json<InstanceView>(await w.taskAction(actor, pendingOf(view)[0]!.id, 'approve', view.revision));
}

describe('T2 单人节点多主体回避：自动跳过', () => {
  it('主体 B 被解析为审批人 → subject_skip（处理人系统、候选记 B），流转下一节点；无同意消息', async () => {
    const w = await approvalWorld(database().db, 'f048-r-skip');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [{ ...NODES.outHead, actions: ON }, NODES.inHrbp] });
    mapSubjects(() => [s.outHead.employeeId]);
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const skipped = view.tasks.find((task) => task.nodeKey === 'out_head')!;
    expect(skipped).toMatchObject({ origin: 'subject_skip', status: 'skipped', candidateUserId: s.outHead.userId });
    expect(skipped.assigneeUserId).toBeNull();
    expect(pendingOf(view)).toEqual([expect.objectContaining({ nodeKey: 'in_hrbp', assigneeUserId: s.inHrbp.userId })]);
    const log = view.logs.find((entry) => entry.event === 'skip' && entry.nodeKey === 'out_head');
    expect(log).toMatchObject({ actorUserId: null, detail: { mechanism: 'subject', handler: '系统' } });
    expect(view.logs.some((entry) => entry.event === 'auto_approve')).toBe(false);
  });

  it('开关关闭时照常派单；主体账号在冻结值里但开关关 → 不回避', async () => {
    const w = await approvalWorld(database().db, 'f048-r-off');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [NODES.outHead] });
    mapSubjects(() => [s.outHead.employeeId]);
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(pendingOf(view)).toEqual([
      expect.objectContaining({ assigneeUserId: s.outHead.userId, origin: 'resolved' }),
    ]);
  });

  it('avoidSelf 与 avoidSubjects 同时命中走 self（改派直线经理）；只开 avoidSubjects 则自动跳过', async () => {
    const w = await approvalWorld(database().db, 'f048-r-self-first');
    const s = await transferScene(w);
    await w.setOrgRoles(s.from, { head: s.subject.employeeId });
    await w.publishedProcess({
      code: 'BOTH',
      nodes: [{ ...NODES.outHead, actions: { avoidSelf: true, avoidSubjects: true } }],
    });
    const both = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(pendingOf(both)).toEqual([
      expect.objectContaining({ assigneeUserId: s.manager.userId, origin: 'self_skip_manager' }),
    ]);
    const other = await approvalWorld(database().db, 'f048-r-subjects-only');
    const t = await transferScene(other);
    await other.setOrgRoles(t.from, { head: t.subject.employeeId });
    await other.publishedProcess({ nodes: [{ ...NODES.outHead, actions: { avoidSelf: false, avoidSubjects: true } }] });
    const only = await other.submit(await other.application(t.subject.employeeId, { departmentId: t.to }));
    expect(only.tasks.find((task) => task.nodeKey === 'out_head')).toMatchObject({ origin: 'subject_skip' });
    expect(only.status).toBe('approved');
  });

  it('全部节点被跳过：实例无人工同意即通过（DEC-329①，设计 §7.1）', async () => {
    const w = await approvalWorld(database().db, 'f048-r-all-skipped');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        { ...NODES.outHead, actions: ON },
        { ...NODES.inHead, actions: ON },
      ],
    });
    mapSubjects(() => [s.outHead.employeeId, s.inHead.employeeId]);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const view = await w.submit(draft);
    expect(view.status).toBe('approved');
    expect(view.tasks.map((task) => task.origin)).toEqual(['subject_skip', 'subject_skip']);
    expect((await w.business(draft.id)).status).not.toBe('in_review');
  });

  it('回避先于相同审批人自动处理：同一人的节点被主体回避，不记 history_skip', async () => {
    const w = await approvalWorld(database().db, 'f048-r-before-same');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        { key: 'a', approver: 'latest_record_department_head' },
        { key: 'b', approver: 'latest_record_department_head', historySameAssigneeSkip: true, actions: ON },
      ],
    });
    mapSubjects(() => [s.outHead.employeeId]);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const view = await approveCurrent(w, await w.submit(draft), s.outHead.userId);
    expect(view.tasks.find((task) => task.nodeKey === 'b')).toMatchObject({ origin: 'subject_skip' });
    expect(view.tasks.some((task) => task.origin === 'history_skip')).toBe(false);
  });

  it('owner 候选（R2-02）：发起人账号在冻结 U(S) 中、人员绑定已解除 → 仍命中，不得记为历史同人自动同意', async () => {
    const w = await approvalWorld(database().db, 'f048-r-owner');
    const s = await transferScene(w);
    const hrEmployee = await w.employee('发起人对应员工');
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx
        .insert(permissionUserPersonLinks)
        .values({ tenantId: w.tenant.id, userId: w.hr.id, employeeId: hrEmployee.id }),
    );
    await w.publishedProcess({
      nodes: [
        { key: 'a', approver: 'owner', actions: { avoidSelf: false } },
        {
          key: 'b',
          approver: 'owner',
          historySameAssigneeSkip: true,
          historySameAssigneeResult: 'skip',
          actions: { avoidSelf: false, avoidSubjects: true },
        },
      ],
    });
    mapSubjects(() => [hrEmployee.id]);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    let view = await w.submit(draft);
    // 发起人账号已冻结进 U(S)；a 节点未开回避，由发起人办理。解除绑定后 owner 候选的 personId 为空（外部账号）
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.delete(permissionUserPersonLinks).where(eq(permissionUserPersonLinks.userId, w.hr.id)),
    );
    view = await approveCurrent(w, view, w.hr.id);
    expect(view.tasks.find((task) => task.nodeKey === 'b')).toMatchObject({ origin: 'subject_skip' });
    expect(view.tasks.some((task) => task.origin === 'history_skip')).toBe(false);
  });
});

describe('T3 / 定义校验：会签或无「同意」出口的节点不能开启 avoidSubjects', () => {
  const create = (w: ApprovalWorld, nodes: Record<string, unknown>[]) =>
    w.request(w.hr.id, 'POST', `${BASE}/processes`, {
      ifMatch: 0,
      body: {
        code: `F048_V_${Math.random().toString(36).slice(2, 8)}`,
        name: 'F-048 校验',
        approvalType: 'transfer',
        exceptionAdminUserId: w.exceptionAdmin,
        conditions: { items: [] },
        nodes,
      },
    });

  it('会签节点开启 → 400 APPROVAL_AVOID_SUBJECTS_UNSUPPORTED，不建流程', async () => {
    const w = await approvalWorld(database().db, 'f048-v-countersign');
    const response = await create(w, [
      { key: 'cs', kind: 'countersign', approvers: ['owner', 'record_department_head'], actions: ON },
    ]);
    expect(await reasonOf(response)).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      reason: 'APPROVAL_AVOID_SUBJECTS_UNSUPPORTED',
    });
    const list = await w.json<{ items: unknown[] }>(await w.request(w.hr.id, 'GET', `${BASE}/processes`));
    expect(list.items).toEqual([]);
  });

  it('单人节点没有「同意」出口时开启 → 400 APPROVAL_AVOID_SUBJECTS_UNSUPPORTED', async () => {
    const w = await approvalWorld(database().db, 'f048-v-no-approve');
    const response = await create(w, [{ key: 'n', approver: 'owner', exits: ['disagree'], actions: ON }]);
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'APPROVAL_AVOID_SUBJECTS_UNSUPPORTED' });
  });

  it('单人节点有「同意」出口时开启 → 201，回显显式 avoidSubjects=true', async () => {
    const w = await approvalWorld(database().db, 'f048-v-ok');
    const created = await w.json<{ latestVersion: { nodes: { actions: { avoidSubjects: boolean } }[] } }>(
      await create(w, [{ key: 'n', approver: 'owner', actions: ON }]),
      201,
    );
    expect(created.latestVersion.nodes[0]!.actions.avoidSubjects).toBe(true);
  });

  it('会签节点的 avoidSelf 现状回归：发起人自审跳过转直线经理', async () => {
    const w = await approvalWorld(database().db, 'f048-v-countersign-self');
    const s = await transferScene(w);
    await w.setOrgRoles(s.from, { head: s.subject.employeeId });
    await w.publishedProcess({
      nodes: [
        {
          key: 'cs',
          kind: 'countersign',
          approvers: ['latest_record_department_head', 'record_department_head'],
          actions: { avoidSelf: true },
        },
      ],
    });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(
      pendingOf(view)
        .map((task) => task.assigneeUserId)
        .sort(),
    ).toEqual([s.manager.userId, s.inHead.userId].sort());
  });
});

describe('T9c 重提追加主体：同一命令内即命中（缓存已刷新）', () => {
  it('第 1 轮不含 B；驳回后适配器给出 B，重提时 B 作为首节点审批人被自动跳过', async () => {
    const w = await approvalWorld(database().db, 'f048-r-resubmit');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [{ ...NODES.outHead, actions: ON }, NODES.inHrbp] });
    let mapped: string[] = [];
    mapSubjects(() => mapped);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    let view = await w.submit(draft);
    expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: s.outHead.userId })]);
    const rejected = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'reject', view.revision),
    );
    expect(rejected.status).toBe('returned');
    mapped = [s.outHead.employeeId];
    const business = await w.business(draft.id);
    await w.json(await w.submitRaw({ id: draft.id, revision: business.revision }));
    view = await w.instanceOf(draft.id);
    expect(view.tasks.filter((task) => task.round === 2 && task.nodeKey === 'out_head')).toEqual([
      expect.objectContaining({ origin: 'subject_skip' }),
    ]);
    expect(pendingOf(view)).toEqual([expect.objectContaining({ nodeKey: 'in_hrbp' })]);
  });
});

describe('T14 R2-04：subject_skip 是系统处理，不阻断前一节点审批人的撤回', () => {
  it('A 同意 → 下一节点被主体回避跳过 → 再下一节点待办 → A 仍可撤回；撤回后被跳过节点重新判定', async () => {
    const w = await approvalWorld(database().db, 'f048-r-retrieve');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [{ ...NODES.outHead, actions: { retrieve: true } }, { ...NODES.inHrbp, actions: ON }, NODES.inHead],
    });
    mapSubjects(() => [s.inHrbp.employeeId]);
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await approveCurrent(w, view, s.outHead.userId);
    expect(view.tasks.find((task) => task.nodeKey === 'in_hrbp')).toMatchObject({ origin: 'subject_skip' });
    expect(pendingOf(view)).toEqual([expect.objectContaining({ nodeKey: 'in_head' })]);
    const approvedTask = view.tasks.find((task) => task.nodeKey === 'out_head' && task.status === 'approved')!;
    expect((await w.detail(view.id, s.outHead.userId)).actions).toContain('retrieve');
    const retrieved = await w.json<InstanceView>(
      await w.request(s.outHead.userId, 'POST', `${BASE}/tasks/${approvedTask.id}/retrieve`, {
        ifMatch: view.revision,
        body: {},
      }),
    );
    expect(pendingOf(retrieved)).toEqual([
      expect.objectContaining({ nodeKey: 'out_head', assigneeUserId: s.outHead.userId, origin: 'retrieve' }),
    ]);
    // 再次同意：被跳过的节点重新判定，仍命中主体回避并被跳过
    const again = await approveCurrent(w, retrieved, s.outHead.userId);
    expect(again.tasks.filter((task) => task.nodeKey === 'in_hrbp' && task.origin === 'subject_skip')).toHaveLength(2);
    expect(pendingOf(again)).toEqual([expect.objectContaining({ nodeKey: 'in_head' })]);
  });
});
