/**
 * F-003：会签节点（DEC-117；流转规则照搬原站三种，DEC-144，`14` §11.4、§12）。
 * AC-APV-21 会签节点的配置、版本与发布；AC-APV-22 任一人同意即可（新节点默认）；AC-APV-23 需所有人同意；
 * AC-APV-24 自定义审批方式（按出口动作设整数 / 百分比，百分比向上取整，先达到者流转；规则无法达成时暂定退回，#57）；
 * AC-APV-25 「不同意」是出口动作、按流转规则计数，「驳回」是节点动作、任一人驳回即整单驳回；节点流转后其余待办
 * 自动结束（暂定，Q-M0-57 / #56）；AC-APV-26 审批人解析、审批人为空（DEC-054 / 098）、自审（DEC-068）、相同 / 历史
 * 相同审批人自动处理（`14` §11.6）对会签节点逐人生效。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
  type NodeInput,
  type TaskView,
} from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

/** 调入部门负责人与 HRBP 会签（transferScene：inHead、inHrbp），流转规则缺省为任一人同意即可。 */
const JOINT: NodeInput = {
  key: 'joint',
  name: '调入部门会签',
  kind: 'countersign',
  approvers: ['record_department_head', 'record_department_hrbp'],
};
/** 三人会签：调入负责人、调入 HRBP、调出负责人（outHead）。 */
const TRIO: NodeInput = { ...JOINT, approvers: [...JOINT.approvers!, 'latest_record_department_head'] };
/** 会签之后的单人节点：一级组织负责人（调入部门为一级组织，即 inHead）。 */
const FINAL: NodeInput = { key: 'final', name: '一级组织负责人审批', approver: 'record_first_level_org_head' };
const BOTH_EXITS = ['approve', 'disagree'] as const;

const pendingOf = (view: InstanceView) => view.tasks.filter((task) => task.status === 'pending');

function taskOf(view: InstanceView, userId: string, status = 'pending', nodeKey = 'joint'): TaskView {
  const task = view.tasks
    .filter((item) => item.assigneeUserId === userId && item.status === status && item.nodeKey === nodeKey)
    .at(-1);
  expect(task, `${userId} 在 ${nodeKey} 的 ${status} 任务`).toBeDefined();
  return task!;
}

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { details?: { reason?: string } } };
  return { status: response.status, reason: body.error?.details?.reason };
}

async function started(w: ApprovalWorld, nodes: readonly NodeInput[]) {
  const s = await transferScene(w);
  await w.publishedProcess({ nodes });
  const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
  return { s, draft, view: await w.submit(draft) };
}

async function act(w: ApprovalWorld, view: InstanceView, userId: string, action: 'approve' | 'disagree' | 'reject') {
  return w.json<InstanceView>(await w.taskAction(userId, taskOf(view, userId).id, action, view.revision));
}

const flows = (view: InstanceView) => view.logs.filter((log) => log.event === 'countersign_flow');

describe('AC-APV-21 会签节点的配置、版本与发布', () => {
  it('三种流转规则可保存、发布、编辑最新版本；预设规则按出口动作生成（DEC-144），自定义按行保存', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-define');
    const draft = await w.createProcess({
      nodes: [
        JOINT,
        { ...JOINT, key: 'all', exits: BOTH_EXITS, transitionRule: { type: 'all' } },
        {
          ...TRIO,
          key: 'custom',
          exits: BOTH_EXITS,
          transitionRule: {
            type: 'custom',
            rules: { approve: { kind: 'percent', value: 50 }, disagree: { kind: 'count', value: 2 } },
          },
        },
        FINAL,
      ],
    });
    const [any, all, custom, single] = draft.latestVersion.nodes;
    expect(any).toMatchObject({
      kind: 'countersign',
      approvers: ['record_department_head', 'record_department_hrbp'],
      exits: ['approve'],
      transitionRule: { type: 'any', rules: { approve: { kind: 'count', value: 1 } } },
    });
    expect(all).toMatchObject({
      exits: ['approve', 'disagree'],
      transitionRule: {
        type: 'all',
        rules: { approve: { kind: 'percent', value: 100 }, disagree: { kind: 'count', value: 1 } },
      },
    });
    expect(custom).toMatchObject({
      transitionRule: {
        type: 'custom',
        rules: { approve: { kind: 'percent', value: 50 }, disagree: { kind: 'count', value: 2 } },
      },
    });
    expect(single).toMatchObject({ kind: 'single', approver: 'record_first_level_org_head', exits: ['approve'] });
    const published = await w.publish(draft);
    expect(published.currentVersion!.nodes[2]).toMatchObject({ transitionRule: { type: 'custom' } });
    const next = await w.json<typeof published>(
      await w.request(w.hr.id, 'POST', `${BASE}/processes/${published.id}/versions`, { ifMatch: published.revision }),
      201,
    );
    expect(next.latestVersion).toMatchObject({ versionNo: 2, status: 'draft' });
    expect(next.latestVersion.nodes.map((node) => node.transitionRule?.type ?? null)).toEqual([
      'any',
      'all',
      'custom',
      null,
    ]);
    // 读出的节点（含预设规则按出口动作生成的条件）原样写回草稿可以保存，不改变配置。
    const { name, priority, isFallback, exceptionAdminUserId, conditions, nodes } = next.latestVersion;
    const saved = await w.json<typeof published>(
      await w.request(w.hr.id, 'PUT', `${BASE}/processes/${published.id}/draft`, {
        ifMatch: next.revision,
        body: { name, priority, isFallback, exceptionAdminUserId, conditions, nodes },
      }),
    );
    expect(saved.latestVersion.nodes).toEqual(next.latestVersion.nodes);
  });

  it('结构校验：审批人、流转规则、出口动作与 DEC-106 都按节点类型校验，违规一律 400', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-invalid');
    const custom = (rules: object, exits: NodeInput['exits'] = BOTH_EXITS): NodeInput => ({
      ...JOINT,
      exits,
      transitionRule: { type: 'custom', rules } as NodeInput['transitionRule'],
    });
    const invalid: NodeInput[] = [
      { key: 'joint', kind: 'countersign' },
      { ...JOINT, approvers: [] },
      { ...JOINT, approvers: ['record_department_head', 'record_department_head'] },
      { ...JOINT, approver: 'record_department_head' },
      { ...JOINT, transitionRule: { type: 'ratio' as 'any' } },
      { ...JOINT, transitionRule: { type: 'any', rules: { approve: { kind: 'count', value: 2 } } } },
      { ...JOINT, transitionRule: { type: 'custom' } },
      custom({ approve: { kind: 'count', value: 1 } }),
      custom({ approve: { kind: 'count', value: 1 }, disagree: { kind: 'count', value: 1 } }, ['approve']),
      custom({ approve: { kind: 'percent', value: 100.5 }, disagree: { kind: 'count', value: 1 } }),
      custom({ approve: { kind: 'percent', value: 0 }, disagree: { kind: 'count', value: 1 } }),
      custom({ approve: { kind: 'percent', value: 33.333 }, disagree: { kind: 'count', value: 1 } }),
      custom({ approve: { kind: 'count', value: 0 }, disagree: { kind: 'count', value: 1 } }),
      custom({ approve: { kind: 'count', value: 1.5 }, disagree: { kind: 'count', value: 1 } }),
      { ...JOINT, sameAssigneeSkip: true, sameAssigneeResult: 'skip' },
      { ...JOINT, historySameAssigneeSkip: true, historySameAssigneeResult: 'skip' },
      { key: 'single', approvers: ['record_department_head'] },
      { key: 'single', approver: 'record_department_head', transitionRule: { type: 'any' } },
      { key: 'single' },
      { ...TRANSFER_NODES[0]!, exits: [] },
      { ...TRANSFER_NODES[0]!, exits: ['approve', 'approve'] },
      { ...TRANSFER_NODES[0]!, exits: ['reject' as 'approve'] },
    ];
    for (const node of invalid) {
      const response = await w.request(w.hr.id, 'POST', `${BASE}/processes`, {
        ifMatch: 0,
        body: {
          code: `P_${randomUUID().slice(0, 8)}`,
          name: '非法会签',
          approvalType: 'transfer',
          exceptionAdminUserId: w.exceptionAdmin,
          conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
          nodes: [node],
        },
      });
      expect(response.status, JSON.stringify(node)).toBe(400);
    }
  });
});

describe('AC-APV-22 任一人同意即可（新会签节点默认）', () => {
  it('全部审批人同时收到待办；任一人同意即流转，其余未处理任务自动结束、不能再处理', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-any');
    const { s, view: submitted } = await started(w, [JOINT, FINAL]);
    expect(submitted).toMatchObject({ status: 'running', currentNodeKey: 'joint' });
    expect(
      pendingOf(submitted)
        .map((task) => [task.assigneeUserId, task.origin])
        .sort(),
    ).toEqual(
      [
        [s.inHead.userId, 'resolved'],
        [s.inHrbp.userId, 'resolved'],
      ].sort(),
    );
    for (const user of [s.inHead.userId, s.inHrbp.userId]) {
      expect((await w.todos(user)).items).toEqual([expect.objectContaining({ instanceId: submitted.id })]);
    }
    const headTask = taskOf(submitted, s.inHead.userId);
    const view = await act(w, submitted, s.inHrbp.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
    expect(view.tasks.find((task) => task.id === headTask.id)).toMatchObject({ status: 'ended' });
    expect(view.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'countersign_end',
          nodeKey: 'joint',
          detail: expect.objectContaining({ userId: s.inHead.userId, reason: '因节点已通过而结束' }),
        }),
      ]),
    );
    expect(flows(view)).toEqual([expect.objectContaining({ detail: expect.objectContaining({ exit: 'approve' }) })]);
    expect((await w.todos(s.inHead.userId)).items).toEqual([
      expect.objectContaining({ nodeKey: 'final', instanceId: view.id }),
    ]);
    expect(await reasonOf(await w.taskAction(s.inHead.userId, headTask.id, 'approve', view.revision))).toEqual({
      status: 409,
      reason: 'APPROVAL_TASK_CLOSED',
    });
  });

  it('会签是最后一个节点：一人同意即整单通过', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-any-last');
    const { s, view: submitted } = await started(w, [JOINT]);
    const view = await act(w, submitted, s.inHead.userId, 'approve');
    expect(view).toMatchObject({ status: 'approved', currentNodeKey: null });
    expect(taskOf(view, s.inHrbp.userId, 'ended')).toBeDefined();
  });
});

describe('AC-APV-23 需所有人同意', () => {
  it('一人同意后节点仍停留；全部同意才沿同意流转，只流转一次', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-all');
    const { s, view: submitted } = await started(w, [{ ...JOINT, transitionRule: { type: 'all' } }, FINAL]);
    let view = await act(w, submitted, s.inHead.userId, 'approve');
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'joint' });
    expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: s.inHrbp.userId })]);
    view = await act(w, view, s.inHrbp.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
    expect(pendingOf(view)).toEqual([expect.objectContaining({ nodeKey: 'final', assigneeUserId: s.inHead.userId })]);
    expect(flows(view)).toHaveLength(1);
  });

  it('「不同意」= 整数 1：任一人不同意即沿不同意连线流转到结束——流程结束、业务不生效，已同意的记录保留', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-all-disagree');
    const nodes = [{ ...JOINT, exits: BOTH_EXITS, transitionRule: { type: 'all' as const } }, FINAL];
    const { s, draft, view: submitted } = await started(w, nodes);
    let view = await act(w, submitted, s.inHead.userId, 'approve');
    view = await act(w, view, s.inHrbp.userId, 'disagree');
    expect(view).toMatchObject({ status: 'disapproved', currentNodeKey: null });
    expect((await w.business(draft.id)).status).toBe('disapproved');
    expect(taskOf(view, s.inHead.userId, 'approved')).toBeDefined();
    expect(taskOf(view, s.inHrbp.userId, 'disagreed')).toBeDefined();
    expect(flows(view)).toEqual([expect.objectContaining({ detail: expect.objectContaining({ exit: 'disagree' }) })]);
  });
});

describe('AC-APV-24 自定义审批方式（DEC-144）', () => {
  const customTrio = (rules: object): NodeInput => ({
    ...TRIO,
    exits: BOTH_EXITS,
    actions: { addSign: true },
    transitionRule: { type: 'custom', rules } as NodeInput['transitionRule'],
  });

  it('百分比向上取整（5 人 50% → 3 人），并加签人计入人数；某动作先达到其规则即沿该动作流转', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-custom-percent');
    const nodes = [
      customTrio({ approve: { kind: 'percent', value: 50 }, disagree: { kind: 'count', value: 3 } }),
      FINAL,
    ];
    const { s, view: submitted } = await started(w, nodes);
    const [finance, auditor] = [await w.member('财务'), await w.member('审计')];
    let view = await w.json<InstanceView>(
      await w.taskAction(s.inHead.userId, taskOf(submitted, s.inHead.userId).id, 'add-sign', submitted.revision, {
        userIds: [finance, auditor],
        type: 'parallel',
      }),
    );
    expect(pendingOf(view)).toHaveLength(5);
    view = await act(w, view, s.inHead.userId, 'approve');
    view = await act(w, view, s.outHead.userId, 'disagree');
    view = await act(w, view, finance, 'approve');
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'joint' });
    view = await act(w, view, auditor, 'approve');
    expect(view.currentNodeKey).toBe('final');
    expect(taskOf(view, s.inHrbp.userId, 'ended')).toBeDefined();
    expect(flows(view)).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ exit: 'approve', count: 3, threshold: 3 }) }),
    ]);
  });

  it('「不同意」= 整数 2：第一人不同意节点不动，第二人不同意才沿不同意连线流转到结束', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-custom-count');
    const nodes = [customTrio({ approve: { kind: 'percent', value: 100 }, disagree: { kind: 'count', value: 2 } })];
    const { s, view: submitted } = await started(w, nodes);
    let view = await act(w, submitted, s.inHead.userId, 'disagree');
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'joint' });
    expect(pendingOf(view)).toHaveLength(2);
    view = await act(w, view, s.inHrbp.userId, 'disagree');
    expect(view).toMatchObject({ status: 'disapproved' });
    expect(taskOf(view, s.outHead.userId, 'ended')).toMatchObject({ status: 'ended' });
    expect(view.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'countersign_end',
          detail: expect.objectContaining({ userId: s.outHead.userId, reason: '因节点已按不同意流转而结束' }),
        }),
      ]),
    );
  });

  it('全部处理完仍没有动作达到规则（含整数大于实际人数）：暂定按不通过退回发起人，不留无人可办的节点（#57）', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-custom-stalled');
    const rules = { approve: { kind: 'count', value: 2 }, disagree: { kind: 'count', value: 2 } };
    const { s, view: submitted } = await started(w, [
      { ...JOINT, exits: BOTH_EXITS, transitionRule: { type: 'custom', rules } as NodeInput['transitionRule'] },
    ]);
    let view = await act(w, submitted, s.inHead.userId, 'approve');
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'joint' });
    view = await act(w, view, s.inHrbp.userId, 'disagree');
    expect(view).toMatchObject({ status: 'returned' });
    expect(view.logs).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'countersign_stalled', nodeKey: 'joint' })]),
    );

    const w2 = await approvalWorld(database().db, 'apv-cs-custom-unreachable');
    const { s: s2, view: submitted2 } = await started(w2, [
      {
        ...JOINT,
        transitionRule: { type: 'custom', rules: { approve: { kind: 'count', value: 3 } } },
      },
    ]);
    let both = await act(w2, submitted2, s2.inHead.userId, 'approve');
    both = await act(w2, both, s2.inHrbp.userId, 'approve');
    expect(both).toMatchObject({ status: 'returned' });

    // 进入节点时就无法达成：两席都按历史相同审批人自动同意，仍不够“整数 3”，同样退回，不停在没有待办的节点。
    const w3 = await approvalWorld(database().db, 'apv-cs-custom-entry');
    const { s: s3, view: submitted3 } = await started(w3, [
      { ...JOINT, transitionRule: { type: 'all' } },
      {
        ...JOINT,
        key: 'again',
        historySameAssigneeSkip: true,
        transitionRule: { type: 'custom', rules: { approve: { kind: 'count', value: 3 } } },
      },
    ]);
    let entry = await act(w3, submitted3, s3.inHead.userId, 'approve');
    entry = await act(w3, entry, s3.inHrbp.userId, 'approve');
    expect(entry).toMatchObject({ status: 'returned' });
    expect(entry.tasks.filter((task) => task.nodeKey === 'again').map((task) => task.origin)).toEqual([
      'history_skip',
      'history_skip',
    ]);
    expect(entry.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'countersign_stalled', nodeKey: 'again', detail: expect.anything() }),
      ]),
    );
  });
});

describe('AC-APV-25 「不同意」与「驳回」（DEC-144）', () => {
  it('驳回不进流转规则：即使「不同意」要 2 人，任一人驳回即整单驳回，其余会签任务取消；重提后会签节点重新激活', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-reject');
    const rules = { approve: { kind: 'count', value: 1 }, disagree: { kind: 'count', value: 2 } };
    const nodes = [
      {
        ...JOINT,
        exits: BOTH_EXITS,
        transitionRule: { type: 'custom', rules } as NodeInput['transitionRule'],
        rejectResubmit: 'rejecting_node' as const,
      },
      FINAL,
    ];
    const { s, draft, view: submitted } = await started(w, nodes);
    const headTask = taskOf(submitted, s.inHead.userId);
    const view = await w.json<InstanceView>(
      await w.taskAction(s.inHrbp.userId, taskOf(submitted, s.inHrbp.userId).id, 'reject', submitted.revision, {
        comment: '编制不足',
      }),
    );
    expect(view.status).toBe('returned');
    expect(view.tasks.find((task) => task.id === headTask.id)).toMatchObject({ status: 'cancelled' });
    expect(flows(view)).toEqual([]);
    await w.json(await w.submitRaw(await w.business(draft.id)));
    const resubmitted = await w.instanceOf(draft.id);
    expect(resubmitted).toMatchObject({ status: 'running', currentNodeKey: 'joint' });
    expect(
      pendingOf(resubmitted)
        .map((task) => task.assigneeUserId)
        .sort(),
    ).toEqual([s.inHead.userId, s.inHrbp.userId].sort());
    expect(pendingOf(resubmitted).every((task) => task.round === 2)).toBe(true);
  });

  it('节点没有「不同意」出口动作：不能不同意，详情也不公布；有时公布', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-no-disagree');
    const { s, view: submitted } = await started(w, [JOINT]);
    const detail = await w.detail(submitted.id, s.inHead.userId);
    expect(detail.actions).toEqual(expect.arrayContaining(['approve', 'reject']));
    expect(detail.actions).not.toContain('disagree');
    expect(
      await reasonOf(
        await w.taskAction(s.inHead.userId, taskOf(submitted, s.inHead.userId).id, 'disagree', submitted.revision),
      ),
    ).toEqual({ status: 409, reason: 'APPROVAL_ACTION_DISABLED' });

    const w2 = await approvalWorld(database().db, 'apv-cs-with-disagree');
    const { s: s2, view: other } = await started(w2, [{ ...JOINT, exits: BOTH_EXITS }]);
    expect((await w2.detail(other.id, s2.inHead.userId)).actions).toContain('disagree');
    const ended = await act(w2, other, s2.inHead.userId, 'disagree');
    expect(ended.status).toBe('disapproved');
    expect(taskOf(ended, s2.inHrbp.userId, 'ended')).toBeDefined();
  });
});

describe('AC-APV-26 会签节点的审批人规则逐人生效', () => {
  it('中间会签节点有一位审批人为空：该位转异常管理员（DEC-054），另一位照常；需所有人同意时两人都要同意', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-empty');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, { ...JOINT, transitionRule: { type: 'all' } }] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision));
    expect(view.currentNodeKey).toBe('joint');
    expect(taskOf(view, w.exceptionAdmin)).toMatchObject({ isExceptionAdmin: true, origin: 'exception_admin' });
    expect(taskOf(view, s.inHead.userId)).toMatchObject({ isExceptionAdmin: false, origin: 'resolved' });
    view = await act(w, view, w.exceptionAdmin, 'approve');
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'joint' });
    view = await act(w, view, s.inHead.userId, 'approve');
    expect(view.status).toBe('approved');
  });

  it('首个节点是会签且有一位审批人为空：提交即报错，不生成实例（DEC-054 逐人）', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-first-empty');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [JOINT] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    expect(await reasonOf(await w.submitRaw(draft))).toEqual({ status: 409, reason: 'APPROVAL_FIRST_NODE_EMPTY' });
    expect(await w.business(draft.id)).toMatchObject({ status: 'draft' });
  });

  it('自审逐人：解析为异动本人的那一位跳过（不计同意）、转其直线经理，其他审批人不受影响（DEC-068）', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-self');
    const s = await transferScene(w);
    await w.setOrgRoles(s.from, { head: s.subject.employeeId });
    await w.publishedProcess({
      nodes: [{ ...JOINT, approvers: ['latest_record_department_head', 'record_department_head'] }],
    });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(view.tasks.find((task) => task.origin === 'self_skip')).toMatchObject({
      assigneeUserId: s.subject.userId,
      status: 'skipped',
    });
    expect(
      pendingOf(view)
        .map((task) => [task.assigneeUserId, task.origin])
        .sort(),
    ).toEqual(
      [
        [s.manager.userId, 'self_skip_manager'],
        [s.inHead.userId, 'resolved'],
      ].sort(),
    );
  });

  it('相同审批人逐人自动同意并计入流转规则：需所有人同意时只等其他人；任一人同意即可时进入节点即流转', async () => {
    const same: NodeInput = {
      ...JOINT,
      approvers: ['latest_record_department_head', 'record_department_head'],
      sameAssigneeSkip: true,
    };
    const w = await approvalWorld(database().db, 'apv-cs-same');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, { ...same, transitionRule: { type: 'all' } }] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision));
    expect(view.currentNodeKey).toBe('joint');
    expect(view.tasks.find((task) => task.nodeKey === 'joint' && task.origin === 'same_skip')).toMatchObject({
      assigneeUserId: s.outHead.userId,
      status: 'approved',
    });
    expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: s.inHead.userId })]);

    const w2 = await approvalWorld(database().db, 'apv-cs-same-any');
    const s2 = await transferScene(w2);
    await w2.publishedProcess({ nodes: [TRANSFER_NODES[0]!, same] });
    let any = await w2.submit(await w2.application(s2.subject.employeeId, { departmentId: s2.to }));
    any = await w2.json(await w2.taskAction(s2.outHead.userId, pendingOf(any)[0]!.id, 'approve', any.revision));
    expect(any.status).toBe('approved');
    expect(taskOf(any, s2.inHead.userId, 'ended')).toBeDefined();
    expect((await w2.todos(s2.inHead.userId)).items).toEqual([]);
  });

  it('两个表达式解析为同一人：只派一条任务，按一人计', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-dedup');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: s.inHead.employeeId });
    await w.publishedProcess({ nodes: [{ ...JOINT, transitionRule: { type: 'all' } }] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: s.inHead.userId })]);
    view = await act(w, view, s.inHead.userId, 'approve');
    expect(view.status).toBe('approved');
  });
});
