/**
 * AC-APV-F478-13（S1，设计 §3.2.1 / §3.4）：撤回、驳回后重提、跳转在有路由时的前驱与后继。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  activationsOf,
  approveCurrent,
  approveTo,
  direct,
  otherwise,
  pendingKey,
  pendingOf,
  publishRouted,
  resubmitWith,
  routeScene,
  taskPost,
  when,
} from './AC-APV-F478-support.js';

const testDb = useTestDb();

describe('AC-APV-F478-13 撤回 / 重提 / 跳转', () => {
  it('撤回：下游未处理时可撤回；下游已被自动处理后不可撤回', async () => {
    const s = await routeScene(testDb().db, 'f478-13-retrieve');
    const same = { type: 'specified' as const, value: s.people.n1.userId };
    await publishRouted(s.w, s.nodes({ n3: { approver: same, sameAssigneeSkip: true } }), {
      n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))],
    });

    const open = await s.start(s.depts.d2);
    const afterOpen = await approveCurrent(s, open);
    expect(pendingKey(afterOpen)).toBe('n2');
    const n1Task = afterOpen.tasks.find((t) => t.nodeKey === 'n1')!;
    const retrieved = await taskPost(s, afterOpen, 'retrieve', {}, n1Task.id, s.people.n1.userId);
    expect(retrieved.status, await retrieved.clone().text()).toBe(200);
    expect(pendingKey(await s.w.detail(open.id))).toBe('n1');

    // 下游 N3 被系统自动处理（相同审批人）不算人工处理，与 main 一致仍可撤回
    const auto = await approveCurrent(s, await s.start(s.depts.d1));
    expect(pendingKey(auto)).toBe('n4');
    const autoFirst = auto.tasks.find((t) => t.nodeKey === 'n1')!;
    const again = await taskPost(s, auto, 'retrieve', {}, autoFirst.id, s.people.n1.userId);
    expect(again.status, await again.clone().text()).toBe(200);

    // 下游 N2 已被人工同意 → 不可撤回
    const second = await approveCurrent(s, await s.start(s.depts.d2));
    const moved = await approveCurrent(s, second);
    expect(pendingKey(moved)).toBe('n3');
    const first = moved.tasks.find((t) => t.nodeKey === 'n1')!;
    const denied = await taskPost(s, moved, 'retrieve', {}, first.id, s.people.n1.userId);
    expect(denied.status).toBe(409);
  });

  it('restart 重提：新快照走另一条分支', async () => {
    const s = await routeScene(testDb().db, 'f478-13-restart');
    await publishRouted(s.w, s.nodes().slice(0, 3), {
      n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))],
    });
    let view = await approveCurrent(s, await s.start(s.depts.d1));
    expect(pendingKey(view)).toBe('n3');
    const rejected = await s.w.taskAction(s.people.n3.userId, pendingOf(view)[0]!.id, 'reject', view.revision, {
      comment: '部门不对',
    });
    expect(rejected.status, await rejected.clone().text()).toBe(200);
    view = await s.w.detail(view.id);
    expect(view.status).toBe('returned');
    view = await resubmitWith(s, view, { departmentId: s.depts.d2 });
    expect(pendingKey(view)).toBe('n1');
    view = await approveCurrent(s, view);
    expect(pendingKey(view)).toBe('n2');
    expect((await activationsOf(s.w, view.id)).at(-2)).toMatchObject({ node_key: 'n1', entry_kind: 'start' });
  });

  it('rejecting_node 重提：回到被驳回的节点，其前驱保持不变', async () => {
    const s = await routeScene(testDb().db, 'f478-13-rejecting');
    await publishRouted(s.w, s.nodes({ n3: { rejectResubmit: 'rejecting_node' } }).slice(0, 3), {
      n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))],
    });
    let view = await approveCurrent(s, await s.start(s.depts.d1));
    const before = (await activationsOf(s.w, view.id)).at(-1)!;
    expect(before).toMatchObject({ node_key: 'n3', from_node_key: 'n1' });
    await s.w.json(
      await s.w.taskAction(s.people.n3.userId, pendingOf(view)[0]!.id, 'reject', view.revision, {
        comment: '补充材料',
      }),
    );
    view = await resubmitWith(s, await s.w.detail(view.id), { place: '补充后的地点' });
    expect(pendingKey(view)).toBe('n3');
    expect((await activationsOf(s.w, view.id)).at(-1)).toMatchObject({
      node_key: 'n3',
      entry_kind: 'resubmit',
      from_node_key: 'n1',
    });
  });

  it('跳转到路径外节点后，按该节点自己的出口继续', async () => {
    const s = await routeScene(testDb().db, 'f478-13-jump');
    await publishRouted(s.w, s.nodes(), {
      n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))],
      n2: [approveTo(direct('n4'))],
    });
    let view = await s.start(s.depts.d1);
    await s.w.json(await taskPost(s, view, 'jump', { toNodeKey: 'n2', comment: '先到 N2' }));
    view = await s.w.detail(view.id);
    expect(pendingKey(view)).toBe('n2');
    view = await approveCurrent(s, view);
    expect(pendingKey(view)).toBe('n4');
  });
});
