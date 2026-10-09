/**
 * F-048 PR-2 办理人 / 目标 / 抄送判定（设计 §4.3、§6 #10～#16、#29，测试 T4）：
 * - 办理人命中冻结的 S / U(S)（异常数据，防御）：approve / reject / transfer / add-sign / cc / retrieve 都 409
 *   APPROVAL_SELF_REVIEW，任务与实例前后不变；
 * - 转交 / 加签目标命中 → 409（整批不加）；抄送目标是主体 → 409（仅节点开启 avoidSubjects），开关关时允许；
 * - 排队激活等入口只在“不具审批资格”时走 F8，冻结后不会新增命中（不变式）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';
import { injectFrozen, NODES, pendingOf, reasonOf, snapshotOf, useSubjectMapping } from './support/f048.js';

const database = useTestDb();
const mapSubjects = useSubjectMapping();
const BASE = '/api/tenant/approval';
const ACTIONS = { avoidSubjects: true, transfer: true, addSign: true, copySend: true, retrieve: true } as const;

async function scene(label: string, actions: Record<string, boolean> = ACTIONS) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({ nodes: [{ ...NODES.outHead, actions }, NODES.inHrbp] });
  return { w, s };
}

async function submitted(w: ApprovalWorld, s: Awaited<ReturnType<typeof transferScene>>) {
  return w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
}

const post = (w: ApprovalWorld, actor: string, taskId: string, action: string, view: InstanceView, body: object) =>
  w.request(actor, 'POST', `${BASE}/tasks/${taskId}/${action}`, { ifMatch: view.revision, body });

describe('T4 办理人命中冻结值（防御）：409，任务不动', () => {
  const cases: [string, (s: { other: string }) => object][] = [
    ['approve', () => ({})],
    ['reject', () => ({})],
    ['transfer', ({ other }) => ({ toUserId: other })],
    ['add-sign', ({ other }) => ({ userIds: [other], type: 'before' })],
    ['cc', ({ other }) => ({ userIds: [other] })],
  ];
  for (const [action, bodyOf] of cases) {
    it(`${action}：办理人账号已在冻结的 U(S) 中 → 409 APPROVAL_SELF_REVIEW，前后对比一致`, async () => {
      const { w, s } = await scene(`f048-a-actor-${action}`);
      const view = await submitted(w, s);
      const other = await w.member('无关成员');
      await injectFrozen(w, view.id, s.outHead.userId);
      const before = await snapshotOf(w, view.id);
      const response = await post(w, s.outHead.userId, pendingOf(view)[0]!.id, action, view, bodyOf({ other }));
      expect(await reasonOf(response)).toMatchObject({
        status: 409,
        code: 'CONFLICT',
        reason: 'APPROVAL_SELF_REVIEW',
        recusal: 'subjects',
      });
      expect(await snapshotOf(w, view.id)).toEqual(before);
    });
  }

  it('retrieve：撤回人账号已在冻结值里 → 409，任务不动', async () => {
    const { w, s } = await scene('f048-a-actor-retrieve');
    let view = await submitted(w, s);
    view = await w.json(await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision));
    const approved = view.tasks.find((task) => task.nodeKey === 'out_head' && task.status === 'approved')!;
    await injectFrozen(w, view.id, s.outHead.userId);
    const before = await snapshotOf(w, view.id);
    const response = await post(w, s.outHead.userId, approved.id, 'retrieve', view, {});
    expect(await reasonOf(response)).toMatchObject({ status: 409, reason: 'APPROVAL_SELF_REVIEW' });
    expect(await snapshotOf(w, view.id)).toEqual(before);
  });

  it('只开 avoidSelf 的节点：冻结值里的主体账号不触发办理人拦截（开关决定判定层）', async () => {
    const { w, s } = await scene('f048-a-actor-self-only', { avoidSelf: true });
    const view = await submitted(w, s);
    await injectFrozen(w, view.id, s.outHead.userId);
    const done = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision),
    );
    expect(pendingOf(done)).toEqual([expect.objectContaining({ nodeKey: 'in_hrbp' })]);
  });
});

describe('T4 目标与抄送', () => {
  it('转交 / 加签目标是主体（账号在冻结 U(S) 中）→ 409，整批不加；无关目标可转交', async () => {
    const { w, s } = await scene('f048-a-target');
    mapSubjects(() => [s.inHead.employeeId]);
    const view = await submitted(w, s);
    const task = pendingOf(view)[0]!;
    const free = await w.member('无关成员');
    const before = await snapshotOf(w, view.id);
    const transfer = await post(w, s.outHead.userId, task.id, 'transfer', view, { toUserId: s.inHead.userId });
    expect(await reasonOf(transfer)).toMatchObject({
      status: 409,
      reason: 'APPROVAL_SELF_REVIEW',
      recusal: 'subjects',
    });
    const addSign = await post(w, s.outHead.userId, task.id, 'add-sign', view, {
      userIds: [free, s.inHead.userId],
      type: 'before',
    });
    expect(await reasonOf(addSign)).toMatchObject({ status: 409, reason: 'APPROVAL_SELF_REVIEW' });
    expect(await snapshotOf(w, view.id)).toEqual(before);
    const ok = await post(w, s.outHead.userId, task.id, 'transfer', view, { toUserId: free });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it('avoidSelf：转交给发起人 / 异动本人仍 409（self），与既有行为一致', async () => {
    const { w, s } = await scene('f048-a-target-self', { avoidSelf: true, transfer: true });
    const view = await submitted(w, s);
    const task = pendingOf(view)[0]!;
    for (const target of [w.hr.id, s.subject.userId]) {
      const response = await post(w, s.outHead.userId, task.id, 'transfer', view, { toUserId: target });
      expect(await reasonOf(response)).toMatchObject({ status: 409, reason: 'APPROVAL_SELF_REVIEW', recusal: 'self' });
    }
  });

  it('抄送目标是主体 → 409（节点开启 avoidSubjects），无关成员可抄送；开关关闭时主体也可被抄送', async () => {
    const { w, s } = await scene('f048-a-cc');
    mapSubjects(() => [s.inHead.employeeId]);
    const view = await submitted(w, s);
    const task = pendingOf(view)[0]!;
    const free = await w.member('抄送成员');
    const before = await snapshotOf(w, view.id);
    const denied = await post(w, s.outHead.userId, task.id, 'cc', view, { userIds: [free, s.inHead.userId] });
    expect(await reasonOf(denied)).toMatchObject({ status: 409, reason: 'APPROVAL_SELF_REVIEW', recusal: 'subjects' });
    expect(await snapshotOf(w, view.id)).toEqual(before);
    const allowed = await post(w, s.outHead.userId, task.id, 'cc', view, { userIds: [free] });
    expect(allowed.status, await allowed.clone().text()).toBe(200);

    const off = await scene('f048-a-cc-off', { copySend: true });
    mapSubjects(() => [off.s.inHead.employeeId]);
    const offView = await submitted(off.w, off.s);
    const offCc = await post(off.w, off.s.outHead.userId, pendingOf(offView)[0]!.id, 'cc', offView, {
      userIds: [off.s.inHead.userId],
    });
    expect(offCc.status, await offCc.clone().text()).toBe(200);
  });
});

describe('T4 排队激活 / 回到原审批人（不变式）：冻结后不新增命中，加签链照常走完', () => {
  it('前加签：加签人同意后回到原审批人，原审批人（非主体）继续办理', async () => {
    const { w, s } = await scene('f048-a-chain');
    const view = await submitted(w, s);
    const signer = await w.member('加签人');
    const added = await w.json<InstanceView>(
      await post(w, s.outHead.userId, pendingOf(view)[0]!.id, 'add-sign', view, { userIds: [signer], type: 'before' }),
    );
    const back = await w.json<InstanceView>(
      await w.taskAction(signer, pendingOf(added)[0]!.id, 'approve', added.revision),
    );
    expect(pendingOf(back)).toEqual([expect.objectContaining({ assigneeUserId: s.outHead.userId })]);
  });
});
