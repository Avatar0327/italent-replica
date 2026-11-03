import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { approvalWorld, type ProcessView } from './AC-APV-support.js';
import { processClient } from './AC-HA-13c-support.js';

const database = useTestDb();
it('F-417⑤：跨流程及版本同名节点归并，名称即钻取键，组数与任务明细一致', async () => {
  const w = await approvalWorld(database().db, 'f417-node');
  w.setNow('2026-10-01T01:00:00.000Z');
  const org = await w.org('合成部门');
  const manager = await w.person('审批经理', org);
  const node = {
    key: 'manager',
    name: '经理审批 & 复核',
    approver: { type: 'object_field' as const, value: 'direct_manager' },
  };
  const process = await w.publishedProcess({ nodes: [node] });
  const tasks: string[] = [];
  async function approve(name: string) {
    const person = await w.person(name, org, { directManagerId: manager.employeeId });
    const business = await w.application(person.employeeId, { departmentId: org }, { effectiveDate: '2026-11-01' });
    const view = await w.submit(business);
    const task = w.pending(view)[0]!;
    await w.json(await w.taskAction(manager.userId, task.id, 'approve', view.revision));
    tasks.push(task.id);
  }
  await approve('第一版本');
  const draft = await w.json<ProcessView>(
    await w.request(w.hr.id, 'POST', `/api/tenant/approval/processes/${process.id}/versions`, {
      ifMatch: process.revision,
    }),
    201,
  );
  await w.publish(draft);
  await approve('第二版本');
  await w.publishedProcess({ priority: -1, nodes: [{ ...node, key: 'another' }] });
  await approve('另一流程');
  const board = processClient(
    w.db,
    { tenant: w.tenant.id, user: w.hr.id },
    { now: () => new Date('2026-10-20T01:00:00Z') },
  );
  const row = await board.component('taskDurationByNode');
  expect(
    row.groups.map((g) => [g.key, g.label, g.count]),
    '同名节点只应出现一组',
  ).toEqual([[node.name, node.name, 3]]);
  await board.expectGroup('taskDurationByNode', { group: node.name }, tasks);
  expect(row.groups.reduce((sum, g) => sum + g.count, 0)).toBe(row.total);
});
