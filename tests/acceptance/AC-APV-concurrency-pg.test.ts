/**
 * 真 PostgreSQL 强制锁竞争（PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）。
 * 屏障事务先占住请求都要用的锁，逐个确认请求已阻塞在锁上再放行，保证它们真正重叠并按确定顺序排队：
 * - X-21（并发创建同编码）：换成“先查重再普通插入”会出现唯一约束冲突（500）。
 * - 清单 11 / N7（统一加锁顺序）：业务撤回先排队、审批同意后排队；旧的“先锁实例再锁员工”会在放行后成环死锁。
 * - N5（交接与最终同意 / 撤回竞争）：交接排在后面，拿到锁时实例已结束，不得写任何东西。
 * - R4-2（成员停用与审批派单交错）：派单不得把新待办落到正在停用的人身上，两者不得成环死锁。
 * - R4-5（并发首次指定替代人）：审计旧值必须是实际被覆盖的那个值。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { revokeMembership, sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
} from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

/** 等到恰有 expected 个会话在等锁（屏障之外不应有别的锁等待）。 */
async function waitForBlocked(db: Db, expected: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (Number(row?.n) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const activity = rowsOf<{ state: string; wait: string | null; query: string }>(
    await db.execute(sql`SELECT state, wait_event_type || ':' || wait_event AS wait, left(query, 160) AS query
      FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`),
  );
  throw new Error(`等待 ${expected} 个会话阻塞超时：${JSON.stringify(activity)}`);
}

async function lockWaiters(db: Db): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
  );
  return Number(row?.n);
}

/** 等到请求结束或恰有 expected 个会话在等锁，返回先发生的那一个（请求不必阻塞时就不会卡在这里）。 */
async function settledOrBlocked(db: Db, request: Promise<unknown>, expected: number) {
  let settled = false;
  void request.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 200; i++) {
    if (settled) return 'settled';
    if ((await lockWaiters(db)) === expected) return 'blocked';
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待请求结束或 ${expected} 个会话阻塞超时`);
}

/** 平台命令的结果：成功为 'ok'，失败为错误本身（不留未处理的拒绝）。 */
function outcomeOf(command: Promise<unknown>): Promise<unknown> {
  return command.then(
    () => 'ok',
    (error: unknown) => error,
  );
}

async function membershipRevision(w: ApprovalWorld, userId: string) {
  const rows = await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`SELECT revision FROM tenant_memberships WHERE tenant_id=${w.tenant.id} AND user_id=${userId}::uuid`),
  );
  return Number(rowsOf<{ revision: number }>(rows)[0]!.revision);
}

function pending(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { details?: { reason?: string } } };
  return { status: response.status, reason: body.error?.details?.reason };
}

describe.runIf(realPostgres)('真 PostgreSQL 强制锁竞争', () => {
  it('X-21：两条同编码创建都阻塞在插入前，放行后一个 201、一个 409，不出现 500', async () => {
    const w = await approvalWorld(database().db, 'apv-pg-create');
    const body = {
      code: 'SameCode',
      name: '同编码流程',
      approvalType: 'transfer',
      exceptionAdminUserId: w.exceptionAdmin,
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
      nodes: [TRANSFER_NODES[0]!],
    };
    const responses = await w.db.transaction(async (barrier) => {
      await barrier.execute(sql`LOCK TABLE approval_processes IN SHARE ROW EXCLUSIVE MODE`);
      const pending = [1, 2].map(() => w.request(w.hr.id, 'POST', `${BASE}/processes`, { ifMatch: 0, body }));
      await waitForBlocked(w.db, 2);
      return pending;
    });
    const results = await Promise.all((await Promise.all(responses)).map(reasonOf));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  });

  it('清单 11 / N7：业务撤回先排队、最后节点同意后排队；统一锁序下不成环，一方成功、另一方按状态 409', async () => {
    const w = await approvalWorld(database().db, 'apv-pg-lock-order');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const view: InstanceView = await w.submit(draft);
    const task = view.tasks.find((item) => item.status === 'pending')!;
    const business = await w.business(draft.id);
    // 员工行受 RLS 保护：屏障须在租户上下文里锁行，否则看不到行、锁不住。
    const responses = await withTenant(w.db, w.tenant.id, async (barrier) => {
      const locked = await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.tenant.id} AND id=${s.subject.employeeId}::uuid FOR UPDATE`);
      expect(rowsOf(locked)).toHaveLength(1);
      // 撤回先排队等员工锁；同意后排队。旧锁序下同意会先拿到实例锁再等员工锁，放行后撤回拿到员工锁、
      // 再等实例锁，两者成环死锁（40P01）；统一锁序下同意排队时不持有实例锁，不会成环。
      const withdraw = w.request(w.hr.id, 'POST', `/api/tenant/employment/businesses/${draft.id}/withdraw`, {
        ifMatch: business.revision,
      });
      await waitForBlocked(w.db, 1);
      const approve = w.taskAction(s.outHead.userId, task.id, 'approve', view.revision);
      await waitForBlocked(w.db, 2);
      return [withdraw, approve];
    });
    const [withdrawn, approved] = await Promise.all((await Promise.all(responses)).map(reasonOf));
    expect(withdrawn).toMatchObject({ status: 200 });
    expect(approved!.status).toBe(409);
    // 死锁会被映射为 APPROVAL_CONCURRENT_CONFLICT；统一锁序下失败方只会因单据状态已变而被拒。
    expect(approved!.reason).not.toBe('APPROVAL_CONCURRENT_CONFLICT');
  });

  /** 第二个节点 HRBP 为空 → 异常管理员待办（最后节点）；发起人不是调用交接的 HR。 */
  async function exceptionScene(label: string) {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    const applicant = await w.member('发起人');
    let view = await w.submit(
      await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: applicant }),
      applicant,
    );
    view = await w.json(await w.taskAction(s.outHead.userId, pending(view).id, 'approve', view.revision));
    expect(pending(view)).toMatchObject({ assigneeUserId: w.exceptionAdmin, isExceptionAdmin: true });
    return { w, s, applicant, view, successor: await w.member('新异常管理员') };
  }

  /** 交接排在结束动作之后：屏障放行后结束动作先完成，交接拿到锁时实例已结束。 */
  async function raceHandover(
    w: ApprovalWorld,
    employeeId: string,
    finish: () => Promise<Response>,
    successor: string,
  ) {
    return withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.tenant.id} AND id=${employeeId}::uuid FOR UPDATE`);
      const finished = finish();
      await waitForBlocked(w.db, 1);
      const handover = w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor },
      });
      await waitForBlocked(w.db, 2);
      return [finished, handover] as const;
    });
  }

  async function writesAfter(w: ApprovalWorld, instanceId: string) {
    return withTenant(w.db, w.tenant.id, async (tx) => {
      const [instance] = rowsOf<{ revision: number; completed_at: string | null }>(
        await tx.execute(sql`SELECT revision,completed_at::text FROM approval_instances
          WHERE tenant_id=${w.tenant.id} AND id=${instanceId}::uuid`),
      );
      const [counts] = rowsOf<{ outbox: number; audits: number; logs: number }>(
        await tx.execute(sql`SELECT
          (SELECT count(*)::int FROM approval_outbox WHERE tenant_id=${w.tenant.id}
            AND object_id=${instanceId}::uuid AND event_type='approval.task.transferred') AS outbox,
          (SELECT count(*)::int FROM audit_events WHERE tenant_id=${w.tenant.id}
            AND object_id=${instanceId} AND action='approval.instance.handover') AS audits,
          (SELECT count(*)::int FROM approval_instance_logs WHERE tenant_id=${w.tenant.id}
            AND instance_id=${instanceId}::uuid AND event='exception_admin_handover') AS logs`),
      );
      return { ...instance!, ...counts! };
    });
  }

  for (const kind of ['approve', 'withdraw'] as const) {
    it(`N5：交接与${kind === 'approve' ? '最终同意' : '发起人撤回'}竞争，拿到锁时实例已结束：不加 revision、不写转交事件`, async () => {
      const { w, s, applicant, view, successor } = await exceptionScene(`apv-pg-n5-${kind}`);
      const finish = () =>
        kind === 'approve'
          ? w.taskAction(w.exceptionAdmin, pending(view).id, 'approve', view.revision)
          : w.instanceAction(applicant, view.id, 'withdraw', view.revision);
      const [finished, handover] = await raceHandover(w, s.subject.employeeId, finish, successor);
      const ended = await w.json<InstanceView & { completedAt: string | null }>(await finished);
      expect(ended.status).toBe(kind === 'approve' ? 'approved' : 'withdrawn');
      const result = await w.json<{ tasks: number }>(await handover);
      expect(result.tasks).toBe(0);
      // 交接拿到锁时实例已结束：实例停在结束动作写下的状态，没有交接的任何痕迹。
      const after = await writesAfter(w, view.id);
      expect(after).toMatchObject({ revision: ended.revision, outbox: 0, audits: 0, logs: 0 });
      expect(new Date(after.completed_at!).toISOString()).toBe(ended.completedAt);
    });
  }

  async function pendingOf(w: ApprovalWorld, userId: string) {
    const [row] = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM approval_tasks
          WHERE tenant_id=${w.tenant.id} AND assignee_user_id=${userId}::uuid AND status='pending'`),
      ),
    );
    return Number(row?.n);
  }

  it('R4-2：停用事务锁住成员行、停在接管扫描时，并发派单不把新待办派给正在停用的异常管理员', async () => {
    const w = await approvalWorld(database().db, 'apv-pg-r42-dispatch');
    const s = await transferScene(w);
    await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    // J：HR 发起，停在异常管理员（交接时按 DEC-092 跳过）；屏障锁住它的员工行，停用会停在对 J 的接管上。
    let held = await w.submit(await w.application(s.manager.employeeId, { departmentId: s.to }));
    held = await w.json(await w.taskAction(s.outHead.userId, pending(held).id, 'approve', held.revision));
    expect(pending(held)).toMatchObject({ assigneeUserId: w.exceptionAdmin });
    // I：另一位发起人的单，停在第一个节点；同意后第二节点为空，按冻结版本应派给异常管理员。
    const applicant = await w.member('发起人');
    const view = await w.submit(
      await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: applicant }),
      applicant,
    );
    const successor = await w.member('新异常管理员');
    await w.json(
      await w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor },
      }),
    );
    const revision = await membershipRevision(w, w.exceptionAdmin);
    const [revoked, approved, order] = await withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.tenant.id} AND id=${s.manager.employeeId}::uuid FOR UPDATE`);
      const revoke = outcomeOf(
        revokeMembership(w.db, { tenantId: w.tenant.id, userId: w.exceptionAdmin, expectedRevision: revision }, cmd()),
      );
      await waitForBlocked(w.db, 1);
      const approve = w.taskAction(s.outHead.userId, pending(view).id, 'approve', view.revision);
      // 停用持有异常管理员的成员行锁：派单方只“拿到或跳过”成员行锁，不等它。
      return [revoke, approve, await settledOrBlocked(w.db, approve, 2)] as const;
    });
    expect(await revoked).toBe('ok');
    const after = await w.json<InstanceView>(await approved);
    expect(order).toBe('settled');
    // 正在停用的异常管理员不可用：由租户管理员接管（DEC-098），停用完成后没有任何待办落在他名下。
    expect(pending(after)).toMatchObject({ nodeKey: 'in_hrbp', assigneeUserId: w.hr.id, isExceptionAdmin: true });
    expect(await pendingOf(w, w.exceptionAdmin)).toBe(0);
    expect(pending(await w.detail(held.id))).toMatchObject({ assigneeUserId: successor });
  });

  it('R4-2：异常管理员本人审批与其停用交错：不成环死锁，随后派给他的新待办被接管', async () => {
    const w = await approvalWorld(database().db, 'apv-pg-r42-deadlock');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    const third = { key: 'in_hrbp_again', name: '调入部门HRBP复核', approver: 'record_department_hrbp' } as const;
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!, third] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, pending(view).id, 'approve', view.revision));
    expect(pending(view)).toMatchObject({ nodeKey: 'in_hrbp', assigneeUserId: w.exceptionAdmin });
    const successor = await w.member('新异常管理员');
    await w.json(
      await w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor },
      }),
    );
    const revision = await membershipRevision(w, w.exceptionAdmin);
    const [approved, revoked] = await withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM approval_instances
        WHERE tenant_id=${w.tenant.id} AND id=${view.id}::uuid FOR UPDATE`);
      // 异常管理员本人的同意先排队（已锁员工、等实例），停用后排队。旧协议下放行后同意要把第三节点派给他本人、
      // 等他的成员行锁，而停用持有成员行锁、等同意持有的员工锁，两者成环死锁（40P01）。
      const approve = w.taskAction(w.exceptionAdmin, pending(view).id, 'approve', view.revision);
      await waitForBlocked(w.db, 1);
      const revoke = outcomeOf(
        revokeMembership(w.db, { tenantId: w.tenant.id, userId: w.exceptionAdmin, expectedRevision: revision }, cmd()),
      );
      await waitForBlocked(w.db, 2);
      return [approve, revoke] as const;
    });
    expect((await approved).status).toBe(200);
    expect(await revoked).toBe('ok');
    const after = await w.detail(view.id);
    expect(pending(after)).toMatchObject({
      nodeKey: 'in_hrbp_again',
      assigneeUserId: successor,
      isExceptionAdmin: true,
    });
    expect(await pendingOf(w, w.exceptionAdmin)).toBe(0);
  });

  it('R4-5：并发首次给同一人指定不同替代人：审计旧值是实际被覆盖的那个值', async () => {
    const w = await approvalWorld(database().db, 'apv-pg-r45');
    const from = await w.member('卸任的异常管理员（未被流程引用）');
    const successors = [await w.member('替代人甲'), await w.member('替代人乙')];
    const responses = await w.db.transaction(async (barrier) => {
      await barrier.execute(sql`LOCK TABLE approval_exception_admin_successors IN EXCLUSIVE MODE`);
      const requests = successors.map((toUserId) =>
        w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
          ifMatch: 0,
          body: { fromUserId: from, toUserId },
        }),
      );
      await waitForBlocked(w.db, 2);
      return requests;
    });
    for (const response of await Promise.all(responses)) expect(response.status, await response.text()).toBe(200);
    type Audit = { before: { successorUserId: string | null }; after: { successorUserId: string } };
    const audits = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<Audit>(
        await tx.execute(sql`SELECT before,after FROM audit_events WHERE tenant_id=${w.tenant.id}
          AND action='approval.exception_admin.designate_successor' AND object_id=${from}`),
      ),
    );
    expect(audits).toHaveLength(2);
    const first = audits.find((audit) => audit.before.successorUserId === null)!;
    const second = audits.find((audit) => audit !== first)!;
    expect(first).toBeDefined();
    expect(second.before.successorUserId).toBe(first.after.successorUserId);
    const [row] = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ successor_user_id: string }>(
        await tx.execute(sql`SELECT successor_user_id FROM approval_exception_admin_successors
          WHERE tenant_id=${w.tenant.id} AND user_id=${from}::uuid`),
      ),
    );
    expect(row!.successor_user_id).toBe(second.after.successorUserId);
  });
});
