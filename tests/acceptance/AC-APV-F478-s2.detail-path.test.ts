/**
 * F-478 S2 详情 path（设计 §4）：[{ nodeKey, name, state, exit? }]，state ∈ passed / current / pending / not_on_path。
 * passed 记实际走过的出口；pending 按当前快照与默认出口推演；路径外节点 not_on_path；
 * 看不到审批记录的人（hideRecords）不披露路径；无路由的线性流程没有 not_on_path。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approveCurrent,
  approveTo,
  disagreeCurrent,
  otherwise,
  pendingOf,
  routeScene,
  taskPost,
  when,
  type RouteScene,
} from './AC-APV-F478-support.js';
import { detailOf, publishViaHttp, type PathStep } from './AC-APV-F478-s2-support.js';
import type { NodeInput } from './AC-APV-support.js';

const testDb = useTestDb();

const states = (path: readonly PathStep[] | undefined) => path?.map((step) => `${step.nodeKey}:${step.state}`);
const ROUTES = (s: RouteScene) => ({ n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))] });

describe('F-478 S2 详情 path', () => {
  it('D1 路径 N1→N3→N4：随办理推进 current / passed 变化，N2 始终 not_on_path；passed 带实际出口', async () => {
    const s = await routeScene(testDb().db, 'f478-path-d1');
    await publishViaHttp(s.w, s.nodes(), ROUTES(s));
    let view = await s.start(s.depts.d1);
    const first = await detailOf(s.w, view.id);
    expect(states(first.path)).toEqual(['n1:current', 'n2:not_on_path', 'n3:pending', 'n4:pending']);
    expect(first.path![0]).toMatchObject({ name: '节点n1' });
    expect(first.path![0]).not.toHaveProperty('exit');
    view = await approveCurrent(s, view);
    const second = await detailOf(s.w, view.id);
    expect(states(second.path)).toEqual(['n1:passed', 'n2:not_on_path', 'n3:current', 'n4:pending']);
    expect(second.path![0]).toMatchObject({ exit: 'approve' });
    view = await approveCurrent(s, view);
    view = await approveCurrent(s, view);
    const done = await detailOf(s.w, view.id);
    expect(done.status).toBe('approved');
    expect(states(done.path)).toEqual(['n1:passed', 'n2:not_on_path', 'n3:passed', 'n4:passed']);
  });

  it('D2 路径 N1→N2→N3→N4 全在路径上', async () => {
    const s = await routeScene(testDb().db, 'f478-path-d2');
    await publishViaHttp(s.w, s.nodes(), ROUTES(s));
    const view = await s.start(s.depts.d2);
    const detail = await detailOf(s.w, view.id);
    expect(states(detail.path)).toEqual(['n1:current', 'n2:pending', 'n3:pending', 'n4:pending']);
  });

  it('不同意出口结束：走过的节点 passed 且 exit=disagree，其余 not_on_path', async () => {
    const s = await routeScene(testDb().db, 'f478-path-disagree');
    await publishViaHttp(s.w, s.nodes({ n1: { exits: ['approve', 'disagree'] } }).slice(0, 3), {});
    const view = await s.start(s.depts.d1);
    await disagreeCurrent(s, view);
    const detail = await detailOf(s.w, view.id);
    expect(detail.status).toBe('disapproved');
    expect(states(detail.path)).toEqual(['n1:passed', 'n2:not_on_path', 'n3:not_on_path']);
    expect(detail.path![0]).toMatchObject({ exit: 'disagree' });
  });

  it('无路由线性流程：没有 not_on_path', async () => {
    const s = await routeScene(testDb().db, 'f478-path-linear');
    await s.w.publishedProcess({ nodes: s.nodes().slice(0, 3) });
    const view = await s.start(s.depts.d1);
    const detail = await detailOf(s.w, view.id);
    expect(states(detail.path)).toEqual(['n1:current', 'n2:pending', 'n3:pending']);
  });

  it('看不到审批记录的人不披露路径（hideRecords）；管理员可见', async () => {
    const s = await routeScene(testDb().db, 'f478-path-hidden');
    await publishViaHttp(s.w, s.nodes({ n1: { hideRecords: true } }), ROUTES(s));
    const view = await s.start(s.depts.d1);
    const assignee = view.tasks.find((task) => task.status === 'pending')!.assigneeUserId;
    const hidden = await detailOf(s.w, view.id, assignee);
    expect(hidden.recordsHidden).toBe(true);
    expect(hidden.path).toEqual([]);
    const admin = await detailOf(s.w, view.id, s.w.hr.id);
    expect(states(admin.path)).toEqual(['n1:current', 'n2:not_on_path', 'n3:pending', 'n4:pending']);
  });

  it('重入清除旧出口：N1 同意→N2 驳回到上一步→N1 再选不同意结束，N1 的 exit=disagree', async () => {
    const s = await routeScene(testDb().db, 'f478-path-reentry');
    await publishViaHttp(s.w, s.nodes({ n1: { exits: ['approve', 'disagree'] } }).slice(0, 3), {});
    let view = await s.start(s.depts.d1);
    view = await approveCurrent(s, view);
    await s.w.json(await taskPost(s, view, 'reject-previous', { comment: '请复核' }));
    view = await s.w.detail(view.id);
    expect(view.currentNodeKey).toBe('n1');
    view = await disagreeCurrent(s, view);
    const detail = await detailOf(s.w, view.id);
    expect(detail.status).toBe('disapproved');
    expect(detail.path!.find((step) => step.nodeKey === 'n1')).toMatchObject({ state: 'passed', exit: 'disagree' });
    expect(detail.path!.find((step) => step.nodeKey === 'n2')).not.toHaveProperty('exit');
  });

  it('会签末节点以领域结算出口为准：同意 / 不同意都是 2 票流转，最高序号者先投不同意，其余两人同意 → exit=approve', async () => {
    const s = await routeScene(testDb().db, 'f478-path-countersign');
    const voters = [s.people.n2, s.people.n3, s.people.n4];
    const joint: NodeInput = {
      key: 'joint',
      name: '三人会签',
      kind: 'countersign',
      approvers: voters.map((person) => ({ type: 'specified', value: person.userId })),
      exits: ['approve', 'disagree'],
      transitionRule: {
        type: 'custom',
        rules: { approve: { kind: 'count', value: 2 }, disagree: { kind: 'count', value: 2 } },
      },
    } as NodeInput;
    await publishViaHttp(s.w, [s.nodes().slice(0, 1)[0]!, joint], {});
    let view = await s.start(s.depts.d1);
    view = await approveCurrent(s, view);
    const seats = pendingOf(view); // 详情里的任务按序号正序
    expect(seats).toHaveLength(3);
    // 序号最高的席位先投“不同意”，再由另外两人先后“同意”：2 票同意先于 2 票不同意达成
    const [first, second, last] = seats as [(typeof seats)[0], (typeof seats)[0], (typeof seats)[0]];
    for (const [task, action] of [
      [last, 'disagree'],
      [first, 'approve'],
      [second, 'approve'],
    ] as const) {
      const current = await s.w.detail(view.id);
      await s.w.json(await s.w.taskAction(task.assigneeUserId, task.id, action, current.revision, { comment: '会签' }));
    }
    const detail = await detailOf(s.w, view.id);
    expect(detail.status).toBe('approved');
    expect(detail.logs.filter((log) => log.event === 'countersign_flow')).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ exit: 'approve' }) }),
    ]);
    expect(detail.path!.find((step) => step.nodeKey === 'joint')).toMatchObject({ state: 'passed', exit: 'approve' });
  });

  it('撤回后重办：N1 同意→撤回→N1 改选不同意结束，N1 的 exit=disagree（作废的流转行不作数）', async () => {
    const s = await routeScene(testDb().db, 'f478-path-retrieve');
    await publishViaHttp(s.w, s.nodes({ n1: { exits: ['approve', 'disagree'] } }).slice(0, 3), {});
    let view = await s.start(s.depts.d1);
    const first = pendingOf(view)[0]!;
    view = await approveCurrent(s, view);
    await s.w.json(await taskPost(s, view, 'retrieve', {}, first.id, first.assigneeUserId));
    view = await s.w.detail(view.id);
    expect(view.currentNodeKey).toBe('n1');
    view = await disagreeCurrent(s, view);
    const detail = await detailOf(s.w, view.id);
    expect(detail.status).toBe('disapproved');
    expect(detail.path!.find((step) => step.nodeKey === 'n1')).toMatchObject({ state: 'passed', exit: 'disagree' });
  });
});
