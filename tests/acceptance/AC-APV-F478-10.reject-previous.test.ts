/**
 * AC-APV-F478-10（S1，设计 §3.2.1）：驳回到上一步回到“路径前驱”，不是序号上的前一个节点；
 * 详情公布的 rejectPrevious 与命令判定同一口径。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  activationsOf,
  approveCurrent,
  approveTo,
  direct,
  disagreeCurrent,
  disagreeTo,
  otherwise,
  pendingKey,
  pendingOf,
  publishRouted,
  routeScene,
  taskPost,
  when,
} from './AC-APV-F478-support.js';

const testDb = useTestDb();

describe('AC-APV-F478-10 驳回到上一步', () => {
  it('① N1 同意经条件到 N3，N3 驳回到上一步回到 N1（不是 N2）', async () => {
    const s = await routeScene(testDb().db, 'f478-10-1');
    await publishRouted(s.w, s.nodes().slice(0, 3), {
      n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))],
    });
    let view = await approveCurrent(s, await s.start(s.depts.d1));
    expect(pendingKey(view)).toBe('n3');
    const asApprover = await s.w.detail(view.id, s.people.n3.userId);
    expect(asApprover.actions).toContain('rejectPrevious');
    const back = await taskPost(s, view, 'reject-previous', { comment: '请复核' });
    expect(back.status, await back.clone().text()).toBe(200);
    view = await s.w.detail(view.id);
    expect(pendingKey(view)).toBe('n1');
    expect(view.tasks.filter((t) => t.nodeKey === 'n2')).toEqual([]);
    expect((await activationsOf(s.w, view.id)).at(-1)).toMatchObject({ node_key: 'n1', entry_kind: 'reject_previous' });
    // N1 是路径起点，没有前驱：不公布，命令也 409
    expect((await s.w.detail(view.id, s.people.n1.userId)).actions).not.toContain('rejectPrevious');
    const none = await taskPost(s, view, 'reject-previous', { comment: '再退' });
    expect(none.status).toBe(409);
  });

  it('② N1 不同意出口接 N3，N3 驳回到上一步回到 N1；N1 改为同意后按当前快照重新求后继', async () => {
    const s = await routeScene(testDb().db, 'f478-10-2');
    await publishRouted(s.w, s.nodes({ n1: { exits: ['approve', 'disagree'] } }).slice(0, 3), {
      n1: [disagreeTo(direct('n3')), approveTo(direct('n2'))],
    });
    let view = await disagreeCurrent(s, await s.start(s.depts.d1));
    expect(pendingKey(view)).toBe('n3');
    await s.w.json(await taskPost(s, view, 'reject-previous', { comment: '回去重看' }));
    view = await s.w.detail(view.id);
    expect(pendingKey(view)).toBe('n1');
    view = await approveCurrent(s, view);
    expect(pendingKey(view)).toBe('n2');
  });

  it('③ 跳转到 N3 后，驳回到上一步回到序号上的前一个节点 N2', async () => {
    const s = await routeScene(testDb().db, 'f478-10-3');
    await publishRouted(s.w, s.nodes().slice(0, 3), { n1: [approveTo(direct('n2'))] });
    let view = await s.start(s.depts.d1);
    const jumped = await taskPost(s, view, 'jump', { toNodeKey: 'n3', comment: '直接到 N3' });
    expect(jumped.status, await jumped.clone().text()).toBe(200);
    view = await s.w.detail(view.id);
    expect(pendingKey(view)).toBe('n3');
    expect((await activationsOf(s.w, view.id)).at(-1)).toMatchObject({
      node_key: 'n3',
      entry_kind: 'jump',
      from_node_key: 'n2',
    });
    await s.w.json(await taskPost(s, view, 'reject-previous', { comment: '退回' }));
    expect(pendingKey(await s.w.detail(view.id))).toBe('n2');
  });

  it('④ 没有路由的线性流程与 main 一致：N3 驳回到上一步回到 N2，逐级回到 N1', async () => {
    const s = await routeScene(testDb().db, 'f478-10-4');
    await s.w.publishedProcess({ nodes: s.nodes().slice(0, 3) });
    let view = await approveCurrent(s, await approveCurrent(s, await s.start(s.depts.d1)));
    expect(pendingKey(view)).toBe('n3');
    await s.w.json(await taskPost(s, view, 'reject-previous', {}));
    view = await s.w.detail(view.id);
    expect(pendingKey(view)).toBe('n2');
    await s.w.json(await taskPost(s, view, 'reject-previous', {}));
    expect(pendingKey(await s.w.detail(view.id))).toBe('n1');
    expect(pendingOf(view).length).toBe(1);
  });
});
