/** DEC-686：空来源转异常管理员后，最终席位仍受 100 人上限约束。 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();
it('100 个有效来源加空来源转异常管理员：运行和仿真均只有 100 席', async () => {
  const w = await approvalWorld(database().db, 'f318a-final-limit');
  const s = await transferScene(w);
  const people: string[] = [];
  for (let i = 0; i < 100; i++) people.push((await w.person(`合成审批席${i}`, s.from)).userId);
  const process = await w.publishedProcess({
    nodes: [
      { key: 'first', approver: { type: 'specified', value: s.manager.userId } },
      {
        key: 'many',
        kind: 'countersign',
        transitionRule: { type: 'all' },
        approvers: [
          ...people.map((value) => ({ type: 'specified' as const, value })),
          { type: 'department', value: 'latest_record_department_hrbp' },
        ],
      },
    ],
  });
  const simulated = await w.json<{ nodes: { approvers?: { approverUserId: string }[] }[] }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/approval/processes/${process.id}/simulate`, {
      body: { scope: 'published', data: { values: { processCode: 'TransferProcessNew' } } },
    }),
  );
  expect.soft(simulated.nodes[1]!.approvers).toHaveLength(100);
  let instance = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
  instance = await w.json<InstanceView>(
    await w.taskAction(s.manager.userId, w.pending(instance)[0]!.id, 'approve', instance.revision),
  );
  expect(w.pending(instance)).toHaveLength(100);
  expect(new Set(w.pending(instance).map((t) => t.assigneeUserId)).size).toBe(100);
}, 120_000);
