/** F-316 / DEC-663：已有节点和在途实例在新增列后保留兜底取人行为。 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { api, definition, publish, reach, view, world } from './AC-EXIT-F316-support.js';

const database = useTestDb({ migrateBefore: '_f316_handover_empty_approver' });

it('DEC-678 升级不回填新策略，旧发布版的兜底配置与在途行为不变', async () => {
  const handle = database();
  const x = await world(handle.db, 'upgrade', false);
  const process = await publish(
    x,
    definition(x, {
      work_handover: { fallbackUserIds: [x.workOwner.userId] },
      other_handover: { fallbackUserIds: [x.hrbp.userId] },
    }),
  );
  const run = await reach(x, 'work_handover', false);
  expect((await x.pendingNode(run.instanceId))?.userId).toBe(x.workOwner.userId);
  await handle.migrate();
  const loaded = await view(await api(x, 'GET', `/${process.id}`));
  expect(loaded).toEqual(process);
  const rows = await x.sqlRows(sql`SELECT empty_approver_policy FROM approval_process_nodes
    WHERE tenant_id=${x.tenantId} AND version_id=${process.currentVersion!.id}::uuid`);
  expect(rows).toEqual(Array.from({ length: 4 }, () => ({ empty_approver_policy: null })));
  const response = await x.decide(run.instanceId);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await x.pendingTasks(run.instanceId)).toEqual([
    expect.objectContaining({ nodeKey: 'other_handover', userId: x.hrbp.userId, isExceptionAdmin: false }),
  ]);
});
