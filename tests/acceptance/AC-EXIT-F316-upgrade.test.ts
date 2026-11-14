/** F-316 / DEC-663：已有节点和在途实例在新增列后保留兜底取人行为。 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { withPreExitRoutesSchema } from './support/pre-exit-routes-schema.js';
import { withPreCustomFieldOptionsSchema } from './support/pre-custom-field-options-schema.js';
import { withPreInternCycleSchema } from './support/pre-intern-cycle-schema.js';
import { api, definition, publish, reach, view, world } from './AC-EXIT-F316-support.js';

const database = useTestDb({ migrateBefore: '_f316_handover_empty_approver' });

it('DEC-678 升级不回填新策略，旧发布版的兜底配置与在途行为不变', async () => {
  const handle = database();
  // 旧结构没有出口路由 / 激活台账 / decision_exit，前置步骤期间临时补上，升级前撤掉（同 pre-blacklist-schema 先例）
  // 当前接口建入职周期会写 employment_cycles.trainee_start_date，旧结构没有，同样临时补列（F-480，support/pre-intern-cycle-schema.ts）
  const { x, process, run } = await withPreInternCycleSchema(handle.db, () =>
    withPreCustomFieldOptionsSchema(handle.db, () =>
      withPreExitRoutesSchema(handle.db, async () => {
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
        return { x, process, run };
      }),
    ),
  );
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
