/** F-305 / DEC-674：交接的终态例外不改变普通任职审批退回后的占用与同实例重提（DEC-103）。 */
import { randomUUID } from 'node:crypto';
import { pgErrorCode, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { activeInstanceOf } from '../../apps/api/src/modules/approval/store.js';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();

it('DEC-103 普通任职 returned 仍为活动实例，唯一索引拒绝另起实例，重提复用原实例', async () => {
  const w = await approvalWorld(database().db, 'f305-employment-returned');
  const scene = await transferScene(w);
  await w.publishedProcess({
    nodes: [{ key: 'in_head', approver: { type: 'department', value: 'record_department_head' } }],
  });
  const draft = await w.application(scene.subject.employeeId, { departmentId: scene.to });
  const initial = await w.submit(draft);
  const task = initial.tasks.find((candidate) => candidate.status === 'pending')!;
  const returned = await w.json<InstanceView>(
    await w.taskAction(scene.inHead.userId, task.id, 'reject', initial.revision),
  );
  expect(returned.status).toBe('returned');
  const active = await withTenant(w.db, w.tenant.id, (tx) => activeInstanceOf(tx, w.tenant.id, 'employment', draft.id));
  expect(active).toMatchObject({ id: initial.id, status: 'returned' });
  // 直接尝试冲突插入只用于核对 DB 约束；预期失败的独立租户事务不会留下新数据。
  const duplicate = withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`
    INSERT INTO approval_instances SELECT (jsonb_populate_record(NULL::approval_instances,
      to_jsonb(a) || jsonb_build_object('id', ${randomUUID()}::text, 'status', 'running'))).*
    FROM approval_instances a WHERE tenant_id=${w.tenant.id} AND id=${initial.id}::uuid`),
  );
  await expect(duplicate).rejects.toSatisfy((error: unknown) => pgErrorCode(error) === '23505');
  const current = await w.business(draft.id);
  await w.json(await w.submitRaw({ id: draft.id, revision: current.revision }));
  const resumed = await w.instanceOf(draft.id);
  expect(resumed).toMatchObject({ id: initial.id, status: 'running', round: 2, versionNo: initial.versionNo });
  expect(resumed.logs.filter((log) => log.event === 'start')).toHaveLength(1);
});
