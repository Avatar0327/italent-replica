/**
 * 真 PostgreSQL 强制锁竞争（PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）。
 * 屏障事务先占住请求都要用的锁，逐个确认请求已阻塞在锁上再放行，保证它们真正重叠并按确定顺序排队：
 * - X-21（并发创建同编码）：换成“先查重再普通插入”会出现唯一约束冲突（500）。
 * - 清单 11 / N7（统一加锁顺序）：业务撤回先排队、审批同意后排队；旧的“先锁实例再锁员工”会在放行后成环死锁。
 * - N5（交接与最终同意 / 撤回竞争）：交接排在后面，拿到锁时实例已结束，不得写任何东西。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
} from './AC-APV-support.js';

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
});
