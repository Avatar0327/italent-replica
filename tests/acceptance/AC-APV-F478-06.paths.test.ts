/**
 * AC-APV-F478-06 / 07（S1，设计 §3）：按条件走不同路径，路径外节点不产生任务；多条命中取优先级数值小的，
 * 都不命中走 Else。激活行的 from_node_key 与实际路径一致。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  activationsOf,
  approveTo,
  otherwise,
  publishRouted,
  routeScene,
  walkApproving,
  when,
} from './AC-APV-F478-support.js';

const testDb = useTestDb();

describe('AC-APV-F478-06 路径分流', () => {
  it('D1 走 N1→N3，D2 走 N1→N2→N3；路径外节点没有任务，激活行记录实际前驱', async () => {
    const s = await routeScene(testDb().db, 'f478-06');
    await publishRouted(s.w, s.nodes().slice(0, 3), {
      n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))],
    });

    const one = await walkApproving(s, await s.start(s.depts.d1));
    expect(one.path).toEqual(['n1', 'n3']);
    expect(one.view.status).toBe('approved');
    expect(one.view.tasks.some((t) => t.nodeKey === 'n2')).toBe(false);
    expect((await activationsOf(s.w, one.view.id)).map((a) => [a.node_key, a.from_node_key, a.entry_kind])).toEqual([
      ['n1', null, 'start'],
      ['n3', 'n1', 'flow'],
    ]);

    const two = await walkApproving(s, await s.start(s.depts.d2));
    expect(two.path).toEqual(['n1', 'n2', 'n3']);
    expect((await activationsOf(s.w, two.view.id)).map((a) => [a.node_key, a.from_node_key, a.from_exit])).toEqual([
      ['n1', null, null],
      ['n2', 'n1', 'approve'],
      ['n3', 'n2', 'approve'],
    ]);
  });
});

describe('AC-APV-F478-07 优先级与 Else', () => {
  it('两条同时命中取优先级数值小的；都不命中走 Else，并记录命中的分支序号', async () => {
    const s = await routeScene(testDb().db, 'f478-07');
    await publishRouted(s.w, s.nodes(), {
      n1: [approveTo(when(2, 'in', [s.depts.d1, s.depts.d2], 'n3'), when(1, 'eq', s.depts.d1, 'n4'), otherwise('n2'))],
    });
    const first = await walkApproving(s, await s.start(s.depts.d1));
    expect(first.path.slice(0, 2)).toEqual(['n1', 'n4']);
    const second = await walkApproving(s, await s.start(s.depts.d2));
    expect(second.path.slice(0, 2)).toEqual(['n1', 'n3']);
    const third = await walkApproving(s, await s.start(s.depts.d3));
    expect(third.path.slice(0, 2)).toEqual(['n1', 'n2']);

    const [, branch] = await activationsOf(s.w, first.view.id);
    expect(branch).toMatchObject({ node_key: 'n4', from_exit: 'approve', from_branch_no: 2 });
    const [, elseBranch] = await activationsOf(s.w, third.view.id);
    expect(elseBranch).toMatchObject({ node_key: 'n2', from_branch_no: 3 });
  });
});
