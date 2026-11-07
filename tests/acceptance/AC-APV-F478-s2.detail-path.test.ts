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
  routeScene,
  when,
  type RouteScene,
} from './AC-APV-F478-support.js';
import { detailOf, publishViaHttp, type PathStep } from './AC-APV-F478-s2-support.js';

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
});
