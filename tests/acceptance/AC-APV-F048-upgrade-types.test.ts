/**
 * F-048 PR-2 真升级（设计 §2.1、§3.2，测试 T11；PR #135 遗留 P3、PR #145 第 1 轮审查 P3-01）：迁移 approval_subjects 之前发起的
 * 离职、员工子集、合同、IDP 在途实例（调动见 AC-APV-F048-upgrade）。库先只迁到该迁移之前，按旧结构发起；再执行升级迁移，确认：
 * - 旧版本节点的 avoid_self=true 不被读成 false（审批人恰是发起人 / 异动本人时仍自审跳过转直线经理，不会派给本人）；
 * - 在途实例没有冻结行，按单主体回退，升级后用新代码继续办理并走完。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, sql, withTenant, type Db } from '@italent/db';
import { PRESET_PROCESSES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { createProcess, publishProcess } from '../../apps/api/src/modules/approval/definitions.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';
import { approvalWorld, transferScene, type InstanceView } from './AC-APV-support.js';
import { contractWorld } from './AC-CT-support.js';
import { planWorld } from './AC-IDP-plan-support.js';
import { pendingOf } from './support/f048.js';
import { withPreAuditSchema } from './support/pre-audit-schema.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb({ migrateBefore: '_approval_subjects' });

/** 旧结构上没有冻结表，而当前发起代码会写它：前置步骤期间临时建一张同列的表，跑完即删（同 AC-APV-F048-upgrade）。 */
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

/** 一类审批的升级后继续办理：所在租户（用于核对没有冻结行）与续办动作。 */
const upgraded = (tenantId: string, run: () => Promise<void>) => ({ tenantId, run });

const LEAVE_CONDITION = { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] };

/** 离职：调出部门负责人恰是离职人员本人，节点 avoid_self=true → 自审跳过转直线经理。 */
async function leaveBefore(db: Db) {
  const w = await approvalWorld(db, 'f048-up-leave');
  const s = await transferScene(w);
  await w.setOrgRoles(s.from, { head: s.subject.employeeId });
  await w.publishedProcess({
    approvalType: 'leave',
    conditions: LEAVE_CONDITION,
    nodes: [{ key: 'head', approver: 'latest_record_department_head', actions: { avoidSelf: true } }],
  });
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
  );
  const created = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: { kind: 'leave', mode: 'application', lastWorkDate: '2026-10-20', fields: {} },
    }),
    201,
  );
  const view = await w.submit(created);
  expect(pendingOf(view)).toEqual([
    expect.objectContaining({ assigneeUserId: s.manager.userId, origin: 'self_skip_manager' }),
  ]);
  return upgraded(w.tenant.id, async () => {
    const done = await w.json<InstanceView>(
      await w.taskAction(s.manager.userId, pendingOf(view)[0]!.id, 'approve', view.revision),
    );
    expect(done.status).toBe('approved');
  });
}

/** 员工子集：员工本人发起、节点审批人为 owner（本人），avoid_self=true → 自审跳过转直线经理。 */
async function personnelBefore(db: Db) {
  const w = await approvalWorld(db, 'f048-up-sub');
  const s = await transferScene(w);
  await w.json(
    await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
      ifMatch: 0,
      body: { value: { education: ['school'] } },
    }),
  );
  await w.publishedProcess({
    approvalType: 'personnel_change',
    conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: 'education' }] },
    nodes: [{ key: 'self', approver: 'owner', formFields: ['school'], actions: { avoidSelf: true } }],
  });
  const record = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/personnel/employees/${s.subject.employeeId}/subsets/education`, {
      ifMatch: 0,
      body: { school: '甲校', educationLevel: '本科' },
    }),
    201,
  );
  const response = await w.request(s.subject.userId, 'POST', '/api/tenant/personnel/change-requests', {
    ifMatch: 0,
    body: {
      employeeId: s.subject.employeeId,
      subset: 'education',
      recordId: record.id,
      targetRevision: record.revision,
      values: { school: '乙校' },
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const view = await w.instanceOf(((await response.json()) as { id: string }).id, s.subject.userId);
  expect(pendingOf(view)).toEqual([
    expect.objectContaining({ assigneeUserId: s.manager.userId, origin: 'self_skip_manager' }),
  ]);
  return upgraded(w.tenant.id, async () => {
    const done = await w.json<InstanceView>(
      await w.taskAction(s.manager.userId, pendingOf(view)[0]!.id, 'approve', view.revision),
    );
    expect(done.status).toBe('approved');
  });
}

/** 合同：预置节点 avoid_self=true，发起人是流程所有者 → 自审跳过转异常管理员（无直线经理）。 */
async function contractBefore(db: Db) {
  const w = await contractWorld(db, 'f048-up-contract');
  const approver = await createUser(
    w.db,
    { email: `review-${randomUUID()}@example.com`, displayName: '合成审批人' },
    cmd(),
  );
  await grantMembership(w.db, { tenantId: w.session.tenant.id, userId: approver.id, expectedRevision: 0 }, cmd());
  await withTenant(w.db, w.session.tenant.id, async (tx) => {
    for (const preset of PRESET_PROCESSES.filter((p) => p.approvalType === 'contract_terminate')) {
      const ctx = {
        tenantId: w.session.tenant.id,
        userId: w.session.user.id,
        timezone: 'Asia/Shanghai',
        now: new Date('2026-10-01T01:00:00Z'),
        commandId: randomUUID(),
        expectedRevision: 0,
      };
      const created = await createProcess(
        tx,
        ctx,
        { code: preset.code, approvalType: preset.approvalType },
        {
          ...preset.definition,
          exceptionAdminUserId: approver.id,
          nodes: [
            {
              ...preset.definition.nodes[0]!,
              kind: 'single',
              approver: 'owner',
              exits: ['approve', 'disagree'],
            },
          ],
        },
      );
      await publishProcess(tx, { ...ctx, expectedRevision: created.revision }, created.id);
    }
  });
  const original = await w.create();
  const result = await w.request('POST', '/commands', {
    ifMatch: original.revision,
    body: {
      operation: 'terminate',
      mode: 'application',
      employeeId: w.employee.id,
      targetId: original.id,
      fields: { actualTerminationDate: '2026-09-30' },
    },
  });
  expect(result.status, await result.clone().text()).toBe(201);
  const pending = async () =>
    withTenant(w.db, w.session.tenant.id, async (tx) =>
      rowsOf<{ id: string; instanceId: string; revision: number; assignee: string; origin: string }>(
        await tx.execute(sql`SELECT t.id,t.instance_id AS "instanceId",i.revision,t.assignee_user_id::text AS assignee,
          t.origin FROM approval_tasks t JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
          WHERE t.status='pending'`),
      ),
    );
  expect(await pending()).toEqual([expect.objectContaining({ assignee: approver.id, origin: 'exception_admin' })]);
  return upgraded(w.session.tenant.id, async () => {
    const [task] = await pending();
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const done = await api.request('POST', '/api/tenant/contracts/todos/batch', {
      tenant: w.session.tenant.id,
      user: approver.id,
      ifMatch: 0,
      body: { action: 'approve', items: [{ id: task!.id, revision: task!.revision }] },
    });
    expect(await done.json()).toMatchObject({ items: [{ status: 200 }] });
    expect((await w.list()).find((c) => c.id === original.id)?.status).toBe('terminated');
  });
}

/** IDP：员工节点显式开启 avoid_self → 员工（计划对象）自审跳过转其直线经理。 */
async function idpBefore(db: Db) {
  const w = await planWorld(db, 'f048-up-idp', {
    nodes: { idp_employee: { actions: { avoidSelf: true } }, idp_tutor: { actions: { avoidSelf: false } } },
  });
  const plan = await w.startedPlan();
  const pending = (await w.instanceOf(plan, 1)).tasks.filter((task) => task.status === 'pending');
  expect(pending).toEqual([
    expect.objectContaining({ nodeKey: 'set_goals', assigneeUserId: w.manager.userId, origin: 'self_skip_manager' }),
  ]);
  return upgraded(w.tenant.id, async () => {
    const view = await w.instanceOf(plan, 1);
    const done = await w.json<InstanceView>(
      await w.taskAction(w.manager.userId, pendingOf(view)[0]!.id, 'approve', view.revision),
    );
    expect(pendingOf(done)).toEqual([expect.objectContaining({ nodeKey: 'approve_plan' })]);
  });
}

it('升级前发起的离职 / 员工子集 / 合同 / IDP 在途实例：avoid_self=true 保持，按单主体回退，升级后继续办理并走完（DEC-329④ / DEC-332①）', async () => {
  const handle = database();
  const continuations = await withPreAuditSchema(handle.db, () =>
    withoutSubjectsTable(handle.db, async () => ({
      leave: await leaveBefore(handle.db),
      personnel: await personnelBefore(handle.db),
      contract: await contractBefore(handle.db),
      idp: await idpBefore(handle.db),
    })),
  );
  await handle.migrate();
  for (const [name, { tenantId, run }] of Object.entries(continuations)) {
    // 升级迁移不回填：存量在途实例没有冻结行（设计 §5.1）；各类型的租户分开，逐个按租户上下文核对
    const frozen = await withTenant(handle.db, tenantId, async (tx) =>
      rowsOf<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM approval_instance_subjects`)),
    );
    expect(Number(frozen[0]!.n), name).toBe(0);
    await run().catch((error: unknown) => {
      throw new Error(`${name} 升级后继续办理失败：${String(error)}`);
    });
  }
});
