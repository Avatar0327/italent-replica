/**
 * F-048 PR-1 真升级：迁移 approval_subjects 之前发起的在途实例（docs/08_设计/F-048_审批多主体回避_设计.md §2.1、§5.3）。
 * 库先只迁到该迁移之前，按旧结构发起调动审批；再执行升级迁移，确认：
 * - 存量节点的列值不被迁移改动（avoid_self 仍为 true），新增开关取 false、命中动作取「跳过」；
 * - 在途实例没有冻结行，回避事实按单主体回退、账号取实时绑定；
 * - 升级后驳回重提只冻结新一轮（不补写升级前的轮次），实例照常走完。
 */
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { loadRecusalFacts } from '../../apps/api/src/modules/approval/subjects.js';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';
import { withPreAuditSchema } from './support/pre-audit-schema.js';

const database = useTestDb({ migrateBefore: '_approval_subjects' });

const rowsOf = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

/**
 * 旧结构上没有冻结表，而当前发起代码会写它：前置步骤期间临时建一张同列的表，跑完即删，等同升级前没有冻结行；
 * 之后由升级迁移按正式结构（RLS、只追加触发器）重建。
 */
async function withoutSubjectsTable<T>(db: Db, run: () => Promise<T>): Promise<T> {
  await db.execute(sql`CREATE TABLE approval_instance_subjects (tenant_id uuid NOT NULL, instance_id uuid NOT NULL,
    round integer NOT NULL, employee_id uuid NOT NULL, user_id uuid, created_at timestamptz NOT NULL)`);
  await db.execute(sql`GRANT SELECT, INSERT ON approval_instance_subjects TO app_user`);
  try {
    return await run();
  } finally {
    await db.execute(sql`DROP TABLE approval_instance_subjects`);
  }
}

it('升级前的在途实例：节点列值保持、无冻结行按单主体回退，升级后重提只冻结新一轮并照常走完', async () => {
  const handle = database();
  const { w, s, process, view } = await withPreAuditSchema(handle.db, () =>
    withoutSubjectsTable(handle.db, async () => {
      const w = await approvalWorld(handle.db, 'f048-upgrade');
      const s = await transferScene(w);
      const process = await w.publishedProcess({
        nodes: [{ key: 'out_head', approver: 'latest_record_department_head', actions: { avoidSelf: true } }],
      });
      const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
      return { w, s, process, view: await w.submit(draft) };
    }),
  );
  await handle.migrate();

  const loaded = await w.json<{ latestVersion: { nodes: Record<string, unknown>[] } }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/approval/processes/${process.id}`),
  );
  expect(loaded.latestVersion.nodes[0]).toMatchObject({
    actions: { avoidSelf: true, avoidSubjects: false },
    avoidSubjectsResult: 'skip',
  });

  const frozen = async () =>
    withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ round: number; employee_id: string }>(
        await tx.execute(sql`SELECT round, employee_id::text FROM approval_instance_subjects
          WHERE tenant_id=${w.tenant.id} AND instance_id=${view.id}::uuid ORDER BY round`),
      ),
    );
  expect(await frozen()).toEqual([]);
  const facts = await withTenant(w.db, w.tenant.id, (tx) =>
    loadRecusalFacts(tx, w.tenant.id, {
      id: view.id,
      initiatorUserId: w.hr.id,
      subjectEmployeeId: s.subject.employeeId,
    }),
  );
  expect([...facts.subjectEmployeeIds]).toEqual([s.subject.employeeId]);
  expect([...facts.subjectUserIds]).toEqual([s.subject.userId]);

  const pending = (current: InstanceView) => current.tasks.find((task) => task.status === 'pending')!;
  const returned = await w.json<InstanceView>(
    await w.taskAction(s.outHead.userId, pending(view).id, 'reject', view.revision),
  );
  expect(returned.status).toBe('returned');
  const business = await w.business(view.businessId);
  await w.json(await w.submitRaw({ id: view.businessId, revision: business.revision }));
  const resubmitted = await w.instanceOf(view.businessId);
  expect(await frozen()).toEqual([{ round: 2, employee_id: s.subject.employeeId }]);

  const done = await w.json<InstanceView>(
    await w.taskAction(s.outHead.userId, pending(resubmitted).id, 'approve', resubmitted.revision),
  );
  expect(done.status).toBe('approved');
});
