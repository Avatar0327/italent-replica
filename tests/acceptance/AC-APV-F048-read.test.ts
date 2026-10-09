/**
 * F-048 PR-2 详情动作、待办与重放（设计 §6 #25～#28、#31，§8.2；测试 T8、T9a、T9b）：
 * - 详情公布的动作与命令执行共用同一判定：办理类按节点级、管理员类按实例级，命中者不公布；响应不新增主体字段（DEC-057）；
 * - 主体回避跳过的节点没有办理人：不进任何人的待办 / “我参与的”；
 * - 成功命令同键重放不重复执行，失败命令原样回放，详情按当前查看人重新读取。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';
import { bind, injectFrozen, NODES, pendingOf, reasonOf, useSubjectMapping } from './support/f048.js';

const database = useTestDb();
const mapSubjects = useSubjectMapping();
const BASE = '/api/tenant/approval';
const ACTIONS = { avoidSubjects: true, transfer: true, addSign: true, copySend: true } as const;

async function scene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({
    nodes: [{ ...NODES.outHead, formFields: ['departmentId'], actions: ACTIONS }, NODES.inHrbp],
  });
  return { w, s };
}

const submit = async (w: ApprovalWorld, s: Awaited<ReturnType<typeof transferScene>>) =>
  w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));

describe('T8 详情动作：与命令同一判定', () => {
  it('办理类：节点级命中者不公布 approve / reject / transfer / addSign / cc；未命中者照常', async () => {
    const { w, s } = await scene('f048-rd-actions');
    const view = await submit(w, s);
    const normal = (await w.detail(view.id, s.outHead.userId)).actions;
    for (const action of ['approve', 'reject', 'transfer', 'addSign', 'cc']) expect(normal).toContain(action);
    await injectFrozen(w, view.id, s.outHead.userId);
    const recused = (await w.detail(view.id, s.outHead.userId)).actions;
    for (const action of ['approve', 'disagree', 'reject', 'transfer', 'addSign', 'edit', 'cc']) {
      expect(recused, action).not.toContain(action);
    }
  });

  it('管理员类：实例级——集合内主体（含非单主体）不公布 adminTransfer / adminIntervene，无关管理员公布', async () => {
    const { w, s } = await scene('f048-rd-admin');
    const member = await w.employee('集合成员');
    const memberUser = await bind(w, member.id, '集合成员账号');
    mapSubjects(() => [member.id]);
    const view = await submit(w, s);
    const other = await w.member('无关管理员');
    const free = (await w.detail(view.id, other)).actions;
    expect(free).toEqual(expect.arrayContaining(['adminTransfer', 'adminIntervene']));
    const subject = (await w.detail(view.id, memberUser)).actions;
    expect(subject).not.toContain('adminTransfer');
    expect(subject).not.toContain('adminIntervene');
  });

  it('响应不新增主体字段（DEC-057）：详情顶层键不含主体集合 / 回避结论', async () => {
    const { w, s } = await scene('f048-rd-fields');
    mapSubjects(() => [s.inHead.employeeId]);
    const view = await submit(w, s);
    const detail = (await w.detail(view.id, s.outHead.userId)) as unknown as Record<string, unknown>;
    expect(Object.keys(detail).filter((key) => /subjects?(Ids|Users)|recus/i.test(key))).toEqual([]);
    expect((detail.form as { values: Record<string, unknown> }).values).toEqual({ departmentId: s.to });
  });
});

describe('T8 待办与我参与：subject_skip 没有办理人', () => {
  it('被主体回避跳过的审批人没有待办，也不在“我参与的”里；下一节点审批人有待办', async () => {
    const w = await approvalWorld(database().db, 'f048-rd-todos');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [{ ...NODES.outHead, actions: { avoidSubjects: true } }, NODES.inHrbp] });
    mapSubjects(() => [s.outHead.employeeId]);
    await submit(w, s);
    expect((await w.todos(s.outHead.userId)).items).toEqual([]);
    const participated = await w.json<{ items: unknown[] }>(
      await w.request(s.outHead.userId, 'GET', `${BASE}/instances?role=participated`),
    );
    expect(participated.items).toEqual([]);
    expect((await w.todos(s.inHrbp.userId)).items).toEqual([expect.objectContaining({ nodeKey: 'in_hrbp' })]);
  });
});

describe('T9a 重放：成功命令不重复执行，失败命令原样回放', () => {
  it('同键同内容重放同意：任务与日志条数不变，返回当前详情', async () => {
    const { w, s } = await scene('f048-rd-replay');
    const view = await submit(w, s);
    const task = pendingOf(view)[0]!;
    const first = await w.request(s.outHead.userId, 'POST', `${BASE}/tasks/${task.id}/approve`, {
      ifMatch: view.revision,
      body: {},
      idempotencyKey: 'f048-approve',
    });
    const done = await w.json<InstanceView>(first);
    const replay = await w.request(s.outHead.userId, 'POST', `${BASE}/tasks/${task.id}/approve`, {
      ifMatch: view.revision,
      body: {},
      idempotencyKey: 'f048-approve',
    });
    const replayed = await w.json<InstanceView>(replay);
    expect(replayed.revision).toBe(done.revision);
    expect(replayed.tasks).toEqual((await w.detail(view.id, s.outHead.userId)).tasks);
    expect(replayed.logs).toHaveLength(done.logs.length);
  });

  it('失败命令（办理人命中冻结值）同键重放 → 回放同一个 409', async () => {
    const { w, s } = await scene('f048-rd-replay-fail');
    const view = await submit(w, s);
    await injectFrozen(w, view.id, s.outHead.userId);
    const send = () =>
      w.request(s.outHead.userId, 'POST', `${BASE}/tasks/${pendingOf(view)[0]!.id}/approve`, {
        ifMatch: view.revision,
        body: {},
        idempotencyKey: 'f048-fail',
      });
    const first = await reasonOf(await send());
    const second = await reasonOf(await send());
    expect(first).toMatchObject({ status: 409, reason: 'APPROVAL_SELF_REVIEW' });
    expect(second).toEqual(first);
  });
});

describe('T9b 交接重放：回执按当前范围裁剪，不重复改派', () => {
  it('同键同内容重放交接：回执一致，任务只改派一次', async () => {
    const w = await approvalWorld(database().db, 'f048-rd-handover');
    const s = await transferScene(w);
    const init = await w.person('发起人', s.from, { directManagerId: s.manager.employeeId });
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [NODES.outHead, NODES.inHrbp] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: init.userId });
    let view = await w.submit(draft, init.userId);
    view = await w.json(await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision));
    const successor = await w.member('替代人');
    const send = () =>
      w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor },
        idempotencyKey: 'f048-handover',
      });
    const first = await w.json<{ tasks: number }>(await send());
    const second = await w.json<{ tasks: number }>(await send());
    expect(second).toEqual(first);
    const after = await w.detail(view.id, init.userId);
    expect(after.tasks.filter((task) => task.origin === 'handover')).toHaveLength(1);
  });
});
