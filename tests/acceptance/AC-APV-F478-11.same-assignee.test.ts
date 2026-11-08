/**
 * AC-APV-F478-11（S1，设计 §3.2.1）：“与上一节点相同审批人自动处理”和“上一节点审批人”都按路径前驱判断，
 * 不再看序号上的前一个节点。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  activationsOf,
  approveCurrent,
  approveTo,
  otherwise,
  pendingKey,
  pendingOf,
  publishRouted,
  routeScene,
  when,
} from './AC-APV-F478-support.js';

const testDb = useTestDb();

describe('AC-APV-F478-11 路径前驱参与自动处理', () => {
  it('N1、N3 同一审批人，路径 N1→N3：N3 开启“与上一节点相同”则自动同意，并记录出口', async () => {
    const s = await routeScene(testDb().db, 'f478-11-skip');
    const same = { type: 'specified' as const, value: s.people.n1.userId };
    await publishRouted(s.w, s.nodes({ n3: { approver: same, sameAssigneeSkip: true } }).slice(0, 3), {
      n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))],
    });
    const view = await approveCurrent(s, await s.start(s.depts.d1));
    expect(view.status).toBe('approved');
    const auto = view.tasks.find((t) => t.nodeKey === 'n3')!;
    expect(auto).toMatchObject({ status: 'approved', origin: 'same_skip' });
    expect(view.tasks.some((t) => t.nodeKey === 'n2')).toBe(false);
    expect((await activationsOf(s.w, view.id)).at(-1)).toMatchObject({ node_key: 'n3', from_node_key: 'n1' });
  });

  it('上一节点审批人取路径前驱（N1），不是序号前一个（N2）', async () => {
    const s = await routeScene(testDb().db, 'f478-11-previous');
    const previous = { type: 'context_variable' as const, value: 'previous_approved' };
    await publishRouted(s.w, s.nodes({ n3: { approver: previous } }).slice(0, 3), {
      n1: [approveTo(when(1, 'eq', s.depts.d1, 'n3'), otherwise('n2'))],
    });
    const view = await approveCurrent(s, await s.start(s.depts.d1));
    expect(pendingKey(view)).toBe('n3');
    expect(pendingOf(view)[0]).toMatchObject({ assigneeUserId: s.people.n1.userId });
  });
});
