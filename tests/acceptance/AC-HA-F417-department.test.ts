import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { it } from 'vitest';
import { approvalWorld } from './AC-APV-support.js';
import { processClient } from './AC-HA-13c-support.js';

const database = useTestDb();
it('AC-HA-F417②：无行为变更，流程所属部门仍取 asOf 主职部门，未来调动不提前影响筛选', async () => {
  const w = await approvalWorld(database().db, 'f417-department');
  const a = await w.org('合成原部门');
  const b = await w.org('合成新部门');
  const manager = await w.person('合成经理', a);
  const person = await w.person('合成主体', a, { directManagerId: manager.employeeId });
  await w.publishedProcess({
    nodes: [{ key: 'manager', approver: { type: 'object_field', value: 'direct_manager' } }],
  });
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${person.employeeId}`),
  );
  await w.json(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${person.employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-10', fields: { departmentId: b } },
    }),
    201,
  );
  const application = await w.application(person.employeeId, { departmentId: b }, { effectiveDate: '2026-12-01' });
  const flow = await w.submit(application);
  const board = processClient(w.db, { tenant: w.tenant.id, user: w.hr.id }, { now: w.clock });
  for (const [day, matching, other] of [
    ['2026-10-01', a, b],
    ['2026-10-20', b, a],
  ]) {
    const query = `asOf=${day}&from=2026-10-01&to=2026-10-20`;
    await board.expectComponent(
      'inFlightCount',
      { all: [flow.id], hits: [flow.id] },
      `${query}&departmentId=${matching}`,
    );
    await board.expectComponent('inFlightCount', { all: [], hits: [] }, `${query}&departmentId=${other}`);
  }
  await w.json(
    await w.taskAction(manager.userId, w.pending(flow)[0]!.id, 'reject', flow.revision, { comment: '合成退回待重提' }),
  );
  await board.expectComponent(
    'inFlightCount',
    { all: [flow.id], hits: [flow.id] },
    `asOf=2026-10-20&from=2026-10-01&to=2026-10-20&departmentId=${b}`,
  );
});
