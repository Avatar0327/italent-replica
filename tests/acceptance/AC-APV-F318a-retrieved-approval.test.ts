/** P2-1 / DEC-097 / DEC-686：撤回的同意不再构成上一节点实际同意者。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();
const previous = { type: 'context_variable' as const, value: 'previous_approved' };

describe('AC-APV-F318a 撤回后的有效同意历史', () => {
  it.each(['single', 'countersign'] as const)('撤回同意再转交，下游 %s 只派实际接手同意者', async (kind) => {
    const w = await approvalWorld(database().db, `f318a-retrieved-${kind}`);
    const s = await transferScene(w);
    const second =
      kind === 'single'
        ? { key: 'two', approver: previous }
        : { key: 'two', kind, approvers: [previous], transitionRule: { type: 'all' as const } };
    await w.publishedProcess({
      nodes: [
        {
          key: 'one',
          approver: { type: 'specified', value: s.outHead.userId },
          actions: { retrieve: true, transfer: true },
        },
        second,
      ],
    });
    let current = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const original = w.pending(current)[0]!;
    current = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, original.id, 'approve', current.revision),
    );
    expect(w.pending(current).map((task) => task.nodeKey)).toEqual(['two']);
    current = await w.json<InstanceView>(
      await w.request(s.outHead.userId, 'POST', `/api/tenant/approval/tasks/${original.id}/retrieve`, {
        ifMatch: current.revision,
        body: {},
      }),
    );
    expect(w.pending(current).map((task) => task.nodeKey)).toEqual(['one']);
    current = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, w.pending(current)[0]!.id, 'transfer', current.revision, {
        toUserId: s.inHead.userId,
      }),
    );
    const response = await w.taskAction(s.inHead.userId, w.pending(current)[0]!.id, 'approve', current.revision);
    expect(response.status, await response.clone().text()).toBe(200);
    current = (await response.json()) as InstanceView;
    expect(w.pending(current).map((task) => [task.nodeKey, task.assigneeUserId])).toEqual([['two', s.inHead.userId]]);
  });

  it('会签前加签人的真实同意仍属于上一节点来源，不以会签计票资格替代', async () => {
    const w = await approvalWorld(database().db, 'f318a-before-signer');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        {
          key: 'one',
          kind: 'countersign',
          approvers: [{ type: 'specified', value: s.outHead.userId }],
          transitionRule: { type: 'all' },
          actions: { addSign: true },
        },
        { key: 'two', kind: 'countersign', approvers: [previous], transitionRule: { type: 'all' } },
      ],
    });
    let current = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    current = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, w.pending(current)[0]!.id, 'add-sign', current.revision, {
        userIds: [s.inHead.userId],
        type: 'before',
      }),
    );
    for (const userId of [s.inHead.userId, s.outHead.userId]) {
      const task = w.pending(current).find((item) => item.assigneeUserId === userId)!;
      current = await w.json<InstanceView>(await w.taskAction(userId, task.id, 'approve', current.revision));
    }
    expect(w.pending(current).every((task) => task.nodeKey === 'two')).toBe(true);
    expect(
      w
        .pending(current)
        .map((task) => task.assigneeUserId)
        .sort(),
    ).toEqual([s.inHead.userId, s.outHead.userId].sort());
  });
});
