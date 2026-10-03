/**
 * PR #35 第二轮清单 主题 G：节点动作。
 * 20 DEC-097 抄送与审批人撤回（纳入版本快照）；26 DEC-095 前加签 / 后加签，任一加签人驳回即整单驳回；
 * X-15 节点催办“继承 / 开启 / 关闭”覆盖流程设置；X-16 不公布不可执行的任职重提动作。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, transferScene, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

describe('清单 20：抄送（DEC-097）', () => {
  it('开启抄送的节点审批人可手动选人抄送：被抄送人收到通知并可查看本节点表单；未开启的节点拒绝', async () => {
    const w = await approvalWorld(database().db, 'apv-cc');
    const s = await transferScene(w);
    const payroll = await w.member('薪资专员');
    await w.publishedProcess({
      nodes: [
        { ...TRANSFER_NODES[0]!, formFields: ['departmentId'] },
        { ...TRANSFER_NODES[1]!, formFields: ['departmentId', 'place'], actions: { copySend: true } },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to, place: '新地点' }));
    const denied = await w.request(s.outHead.userId, 'POST', `${BASE}/tasks/${current(view).id}/cc`, {
      ifMatch: view.revision,
      body: { userIds: [payroll] },
    });
    expect(denied.status).toBe(409);
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    expect(view.actions).not.toContain('cc');
    expect((await w.detail(view.id, s.inHrbp.userId)).actions).toContain('cc');
    view = await w.json(
      await w.request(s.inHrbp.userId, 'POST', `${BASE}/tasks/${current(view).id}/cc`, {
        ifMatch: view.revision,
        body: { userIds: [payroll], comment: '请知悉' },
      }),
    );
    expect(view.logs).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'cc', nodeKey: 'in_hrbp' })]));
    const inbox = await w.json<{ items: { kind: string; instanceId: string }[] }>(
      await w.request(payroll, 'GET', `${BASE}/notifications`),
    );
    expect(inbox.items).toEqual([expect.objectContaining({ kind: 'cc', instanceId: view.id })]);
    const ccView = await w.detail(view.id, payroll);
    expect(ccView.form).toMatchObject({ nodeKey: 'in_hrbp', values: { place: '新地点' } });
    expect(ccView.actions).toEqual([]);
  });
});

describe('清单 20：审批人撤回（DEC-097）', () => {
  it('下一节点尚未处理时可撤回本人的同意，任务回到本人；下一节点处理后不能撤回；未开启的节点拒绝', async () => {
    const w = await approvalWorld(database().db, 'apv-retrieve');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [{ ...TRANSFER_NODES[0]!, actions: { retrieve: true } }, TRANSFER_NODES[1]!, TRANSFER_NODES[2]!],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const first = current(view);
    view = await w.json(await w.taskAction(s.outHead.userId, first.id, 'approve', view.revision));
    expect((await w.detail(view.id, s.outHead.userId)).actions).toContain('retrieve');
    view = await w.json(
      await w.request(s.outHead.userId, 'POST', `${BASE}/tasks/${first.id}/retrieve`, { ifMatch: view.revision }),
    );
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'out_head' });
    expect(current(view)).toMatchObject({ assigneeUserId: s.outHead.userId, origin: 'retrieve' });
    expect(view.tasks.find((task) => task.nodeKey === 'in_hrbp')).toMatchObject({ status: 'cancelled' });
    const reopened = current(view);
    view = await w.json(await w.taskAction(s.outHead.userId, reopened.id, 'approve', view.revision));
    view = await w.json(await w.taskAction(s.inHrbp.userId, current(view).id, 'approve', view.revision));
    const late = await w.request(s.outHead.userId, 'POST', `${BASE}/tasks/${reopened.id}/retrieve`, {
      ifMatch: view.revision,
    });
    expect(late.status).toBe(409);
    const notAllowed = await w.request(s.inHrbp.userId, 'POST', `${BASE}/tasks/${view.tasks.at(-2)!.id}/retrieve`, {
      ifMatch: view.revision,
    });
    expect(notAllowed.status).toBe(409);
  });
});

describe('清单 26：前加签 / 后加签（DEC-095）', () => {
  it('前加签：被加签人先审，同意后回到本人；后加签：本人同意后再由被加签人审', async () => {
    const w = await approvalWorld(database().db, 'apv-add-sign-types');
    const s = await transferScene(w);
    const finance = await w.member('财务');
    await w.publishedProcess({
      nodes: [{ ...TRANSFER_NODES[0]!, actions: { addSign: true } }, TRANSFER_NODES[2]!],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'add-sign', view.revision, {
        userId: finance,
        type: 'before',
      }),
    );
    expect(current(view)).toMatchObject({ assigneeUserId: finance, origin: 'add_sign_before', nodeKey: 'out_head' });
    view = await w.json(await w.taskAction(finance, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ assigneeUserId: s.outHead.userId, origin: 'add_sign_return' });
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'add-sign', view.revision, {
        userId: finance,
        type: 'after',
        comment: '本人同意，请财务复核',
      }),
    );
    expect(view.tasks.filter((task) => task.assigneeUserId === s.outHead.userId).at(-1)).toMatchObject({
      status: 'approved',
    });
    expect(current(view)).toMatchObject({ assigneeUserId: finance, origin: 'add_sign_after', nodeKey: 'out_head' });
    view = await w.json(await w.taskAction(finance, current(view).id, 'approve', view.revision));
    expect(current(view)).toMatchObject({ nodeKey: 'in_head', assigneeUserId: s.inHead.userId });
  });

  it('任一加签人驳回即整单驳回', async () => {
    const w = await approvalWorld(database().db, 'apv-add-sign-reject');
    const s = await transferScene(w);
    const finance = await w.member('财务');
    await w.publishedProcess({ nodes: [{ ...TRANSFER_NODES[0]!, actions: { addSign: true } }, TRANSFER_NODES[2]!] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(
      await w.taskAction(s.outHead.userId, current(view).id, 'add-sign', view.revision, {
        userId: finance,
        type: 'after',
      }),
    );
    view = await w.json(
      await w.taskAction(finance, current(view).id, 'reject', view.revision, { comment: '预算不足' }),
    );
    expect(view.status).toBe('returned');
  });
});

describe('X-15：节点催办覆盖流程设置', () => {
  it('流程关闭催办、节点开启时可催办；节点继承时不可；流程开启、节点关闭时不可', async () => {
    const w = await approvalWorld(database().db, 'apv-urge-override');
    const s = await transferScene(w);
    const urgeOf = async (flow: boolean, node: 'inherit' | 'enabled' | 'disabled', code: string) => {
      const process = await w.createProcess({
        code,
        nodes: [{ ...TRANSFER_NODES[0]!, actions: { urge: node } }],
      });
      const draft = await w.json<{ revision: number }>(
        await w.request(w.hr.id, 'PUT', `${BASE}/processes/${process.id}/draft`, {
          ifMatch: process.revision,
          body: {
            name: '催办覆盖',
            urgeEnabled: flow,
            exceptionAdminUserId: w.exceptionAdmin,
            conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
            nodes: [{ ...TRANSFER_NODES[0]!, actions: { urge: node } }],
          },
        }),
      );
      await w.json(
        await w.request(w.hr.id, 'POST', `${BASE}/processes/${process.id}/publish`, { ifMatch: draft.revision }),
      );
      const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
      const response = await w.instanceAction(w.hr.id, view.id, 'urge', view.revision);
      await w.instanceAction(w.hr.id, view.id, 'withdraw', view.revision);
      await w.json(
        await w.request(w.hr.id, 'POST', `${BASE}/processes/${process.id}/discard`, {
          ifMatch: (
            await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', `${BASE}/processes/${process.id}`))
          ).revision,
        }),
      );
      return { status: response.status, actions: view.actions };
    };
    expect(await urgeOf(false, 'enabled', 'URGE_ON')).toMatchObject({ status: 200 });
    expect((await urgeOf(false, 'inherit', 'URGE_INHERIT')).status).toBe(409);
    expect((await urgeOf(true, 'disabled', 'URGE_OFF')).status).toBe(409);
  });
});

describe('X-16：不公布不可执行的任职重提动作', () => {
  it('任职申请被驳回后，详情不给出审批侧“重提”（须在申请单上修改后提交）', async () => {
    const w = await approvalWorld(database().db, 'apv-resubmit-action');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'reject', view.revision));
    expect(view.status).toBe('returned');
    const owner = await w.detail(view.id);
    expect(owner.actions).toContain('withdraw');
    expect(owner.actions).not.toContain('resubmit');
  });
});
