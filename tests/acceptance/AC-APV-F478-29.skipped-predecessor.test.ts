/**
 * AC-APV-F478-29（S1，设计 §3.2.1）：被自动跳过的节点仍是路径前驱；驳回到上一步重新进入它时，
 * 仍满足跳过条件就再次跳过并回到当前节点，否则停在该节点等人工；之后逐级回到 N1。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  activationsOf,
  approveCurrent,
  pendingKey,
  publishRouted,
  routeScene,
  taskPost,
} from './AC-APV-F478-support.js';

const testDb = useTestDb();

describe('AC-APV-F478-29 被跳过节点作前驱', () => {
  it('N2 无人可审被跳过，N3 的前驱是 N2；驳回到上一步重新进入 N2，仍满足条件再次跳过并新开 N3 激活', async () => {
    const s = await routeScene(testDb().db, 'f478-29-skip-again');
    // N2 的审批人就是本单被调动的人：多主体回避命中，自动跳过，且每次进入都满足（不依赖审批历史）
    await publishRouted(
      s.w,
      s.nodes({ n2: { actions: { avoidSelf: false, avoidSubjects: true, rejectToPrevious: true } } }).slice(0, 3),
      {},
    );
    let view = await approveCurrent(s, await s.startAbout(s.people.n2, s.depts.d1));
    expect(view.tasks.find((t) => t.nodeKey === 'n2')).toMatchObject({ status: 'skipped' });
    expect(pendingKey(view)).toBe('n3');
    const before = await activationsOf(s.w, view.id);
    expect(before.map((a) => [a.node_key, a.from_node_key])).toEqual([
      ['n1', null],
      ['n2', 'n1'],
      ['n3', 'n2'],
    ]);

    await s.w.json(await taskPost(s, view, 'reject-previous', { comment: '回退' }));
    view = await s.w.detail(view.id);
    expect(pendingKey(view)).toBe('n3');
    const after = await activationsOf(s.w, view.id);
    expect(after.map((a) => [a.node_key, a.entry_kind, a.from_node_key])).toEqual([
      ['n1', 'start', null],
      ['n2', 'flow', 'n1'],
      ['n3', 'flow', 'n2'],
      ['n2', 'reject_previous', 'n1'],
      ['n3', 'flow', 'n2'],
    ]);
  });

  it('N2 不再满足跳过条件时停在 N2 等人工；办理后逐级驳回到上一步回到 N1', async () => {
    const s = await routeScene(testDb().db, 'f478-29-stop');
    const same = { type: 'specified' as const, value: s.people.n1.userId };
    await publishRouted(
      s.w,
      s.nodes({ n2: { approver: same, sameAssigneeSkip: true, sameAssigneeResult: 'skip' } }).slice(0, 3),
      {},
    );
    let view = await approveCurrent(s, await s.start(s.depts.d1));
    expect(view.tasks.find((t) => t.nodeKey === 'n2')).toMatchObject({ status: 'skipped' });
    expect(pendingKey(view)).toBe('n3');

    await s.w.json(await taskPost(s, view, 'reject-previous', { comment: '回到 N2' }));
    view = await s.w.detail(view.id);
    expect(pendingKey(view)).toBe('n2');
    view = await approveCurrent(s, view);
    expect(pendingKey(view)).toBe('n3');

    await s.w.json(await taskPost(s, view, 'reject-previous', { comment: '再退' }));
    view = await s.w.detail(view.id);
    expect(pendingKey(view)).toBe('n2');
    await s.w.json(await taskPost(s, view, 'reject-previous', { comment: '继续退' }));
    expect(pendingKey(await s.w.detail(view.id))).toBe('n1');
  });
});
