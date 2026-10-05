/**
 * F-003 / AC-APV-30：同一会签节点多人同时同意 / 驳回，真 PostgreSQL 强制交错（只在设了 TEST_DATABASE_URL 时运行）。
 * 屏障事务先锁住异动员工行——审批命令按 F-008 的全局取锁顺序先锁员工、再锁业务单与实例（`handover.LOCK_ORDER`、
 * R1-T07 交付文档的锁协议表）——逐个确认请求已阻塞后放行，保证两次提交真正重叠、按确定的先后排队。
 * 预期：先排队者生效，后到者按实例 revision 返回 409（不是死锁映射的 APPROVAL_CONCURRENT_CONFLICT）；节点只结算一次、
 * 不重复推进；后到者刷新后再提交，因任务已结束或流程已退回仍是 409。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
  type NodeInput,
  type TaskView,
} from './AC-APV-support.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

/** 任一人同意即可（DEC-144 新节点默认）。 */
const JOINT: NodeInput = {
  key: 'joint',
  name: '调入部门会签',
  kind: 'countersign',
  approvers: ['record_department_head', 'record_department_hrbp'],
};
const FINAL: NodeInput = { key: 'final', name: '调出负责人确认', approver: 'latest_record_department_head' };

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
  throw new Error(`等待 ${expected} 个会话阻塞超时`);
}

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { details?: { reason?: string } } };
  return { status: response.status, reason: body.error?.details?.reason };
}

function taskOf(view: InstanceView, userId: string, status = 'pending'): TaskView {
  const task = view.tasks.filter((item) => item.assigneeUserId === userId && item.status === status).at(-1);
  expect(task, `${userId} 的 ${status} 任务`).toBeDefined();
  return task!;
}

async function scene(label: string, nodes: readonly NodeInput[] = [JOINT, FINAL]) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({ nodes });
  const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
  return { w, s, view, head: taskOf(view, s.inHead.userId), hrbp: taskOf(view, s.inHrbp.userId) };
}

type Act = (w: ApprovalWorld) => Promise<Response>;

/** 锁住异动员工行，按 first → second 的顺序让两次提交排队，再一起放行。 */
async function race(w: ApprovalWorld, employeeId: string, first: Act, second: Act) {
  const responses = await withTenant(w.db, w.tenant.id, async (barrier) => {
    const locked = await barrier.execute(sql`SELECT id FROM employment_employees
      WHERE tenant_id=${w.tenant.id} AND id=${employeeId}::uuid FOR UPDATE`);
    expect(rowsOf(locked)).toHaveLength(1);
    const a = first(w);
    await waitForBlocked(w.db, 1);
    const b = second(w);
    await waitForBlocked(w.db, 2);
    return [a, b];
  });
  return Promise.all((await Promise.all(responses)).map(reasonOf));
}

/** 节点流转、进入下一节点与整单退回的次数：各至多一次。 */
async function settlement(w: ApprovalWorld, instanceId: string) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = rowsOf<{ flows: number; finals: number; returns: number }>(
      await tx.execute(sql`SELECT
        (SELECT count(*)::int FROM approval_instance_logs WHERE tenant_id=${w.tenant.id}
          AND instance_id=${instanceId}::uuid AND event='countersign_flow') AS flows,
        (SELECT count(*)::int FROM approval_tasks WHERE tenant_id=${w.tenant.id}
          AND instance_id=${instanceId}::uuid AND node_key='final') AS finals,
        (SELECT count(*)::int FROM approval_instance_logs WHERE tenant_id=${w.tenant.id}
          AND instance_id=${instanceId}::uuid AND event='reject') AS returns`),
    );
    return row!;
  });
}

describe.runIf(realPostgres)('AC-APV-30 会签节点并发结算（真 PostgreSQL 强制交错）', () => {
  it('任一人同意即可：两人同时同意，先排队者使节点流转，另一人 409；节点只结算一次、只推进一次', async () => {
    const { w, s, view, head, hrbp } = await scene('apv-cs-pg-approve');
    const [first, second] = await race(
      w,
      s.subject.employeeId,
      (world) => world.taskAction(s.inHead.userId, head.id, 'approve', view.revision),
      (world) => world.taskAction(s.inHrbp.userId, hrbp.id, 'approve', view.revision),
    );
    expect(first).toMatchObject({ status: 200 });
    expect(second!.status).toBe(409);
    expect(second!.reason).not.toBe('APPROVAL_CONCURRENT_CONFLICT');
    const after = await w.detail(view.id);
    expect(after.currentNodeKey).toBe('final');
    expect(after.tasks.find((task) => task.id === head.id)).toMatchObject({ status: 'approved' });
    expect(after.tasks.find((task) => task.id === hrbp.id)).toMatchObject({ status: 'ended' });
    expect(await settlement(w, view.id)).toEqual({ flows: 1, finals: 1, returns: 0 });
    // 后到者刷新后再提交：任务已因节点通过而结束，不会再次结算。
    expect(await reasonOf(await w.taskAction(s.inHrbp.userId, hrbp.id, 'approve', after.revision))).toEqual({
      status: 409,
      reason: 'APPROVAL_TASK_CLOSED',
    });
    expect(await settlement(w, view.id)).toEqual({ flows: 1, finals: 1, returns: 0 });
  });

  it('一人同意、一人驳回同时提交：同意先排队则节点流转、驳回 409；驳回先排队则整单驳回、同意 409', async () => {
    {
      const { w, s, view, head, hrbp } = await scene('apv-cs-pg-approve-first');
      const [approved, rejected] = await race(
        w,
        s.subject.employeeId,
        (world) => world.taskAction(s.inHead.userId, head.id, 'approve', view.revision),
        (world) => world.taskAction(s.inHrbp.userId, hrbp.id, 'reject', view.revision),
      );
      expect(approved).toMatchObject({ status: 200 });
      expect(rejected!.status).toBe(409);
      expect(rejected!.reason).not.toBe('APPROVAL_CONCURRENT_CONFLICT');
      expect(await w.detail(view.id)).toMatchObject({ status: 'running', currentNodeKey: 'final' });
      expect(await settlement(w, view.id)).toEqual({ flows: 1, finals: 1, returns: 0 });
    }
    {
      const { w, s, view, head, hrbp } = await scene('apv-cs-pg-reject-first');
      const [rejected, approved] = await race(
        w,
        s.subject.employeeId,
        (world) => world.taskAction(s.inHrbp.userId, hrbp.id, 'reject', view.revision),
        (world) => world.taskAction(s.inHead.userId, head.id, 'approve', view.revision),
      );
      expect(rejected).toMatchObject({ status: 200 });
      expect(approved!.status).toBe(409);
      expect(approved!.reason).not.toBe('APPROVAL_CONCURRENT_CONFLICT');
      const after = await w.detail(view.id);
      expect(after).toMatchObject({ status: 'returned', currentNodeKey: null });
      expect(after.tasks.find((task) => task.id === head.id)).toMatchObject({ status: 'cancelled' });
      expect(await settlement(w, view.id)).toEqual({ flows: 0, finals: 0, returns: 1 });
      expect(await reasonOf(await w.taskAction(s.inHead.userId, head.id, 'approve', after.revision))).toEqual({
        status: 409,
        reason: 'APPROVAL_TASK_CLOSED',
      });
    }
  });

  // P3（PR #58 astra 首审）：更多竞争组合。
  it('两人同时驳回：先排队者整单驳回，另一人 409；只退回一次', async () => {
    const { w, s, view, head, hrbp } = await scene('apv-cs-pg-double-reject');
    const [first, second] = await race(
      w,
      s.subject.employeeId,
      (world) => world.taskAction(s.inHead.userId, head.id, 'reject', view.revision),
      (world) => world.taskAction(s.inHrbp.userId, hrbp.id, 'reject', view.revision),
    );
    expect(first).toMatchObject({ status: 200 });
    expect(second!.status).toBe(409);
    expect(second!.reason).not.toBe('APPROVAL_CONCURRENT_CONFLICT');
    expect(await w.detail(view.id)).toMatchObject({ status: 'returned', currentNodeKey: null });
    expect(await settlement(w, view.id)).toEqual({ flows: 0, finals: 0, returns: 1 });
  });

  it('需所有人同意的最后两票同时提交：先排队者计票，后到者 409；刷新后再提交才流转，只结算一次', async () => {
    const { w, s, view, head, hrbp } = await scene('apv-cs-pg-all', [
      { ...JOINT, transitionRule: { type: 'all' } },
      FINAL,
    ]);
    const [first, second] = await race(
      w,
      s.subject.employeeId,
      (world) => world.taskAction(s.inHead.userId, head.id, 'approve', view.revision),
      (world) => world.taskAction(s.inHrbp.userId, hrbp.id, 'approve', view.revision),
    );
    expect(first).toMatchObject({ status: 200 });
    expect(second!.status).toBe(409);
    const middle = await w.detail(view.id);
    expect(middle.currentNodeKey).toBe('joint');
    expect(await settlement(w, view.id)).toEqual({ flows: 0, finals: 0, returns: 0 });
    expect((await w.taskAction(s.inHrbp.userId, hrbp.id, 'approve', middle.revision)).status).toBe(200);
    expect(await w.detail(view.id)).toMatchObject({ currentNodeKey: 'final' });
    expect(await settlement(w, view.id)).toEqual({ flows: 1, finals: 1, returns: 0 });
  });

  it('一人同意、一人不同意同时提交（DEC-144）：不同意先排队则流程沿不同意结束、同意 409；不进入下一节点', async () => {
    const { w, s, view, head, hrbp } = await scene('apv-cs-pg-disagree', [
      { ...JOINT, exits: ['approve', 'disagree'] },
      FINAL,
    ]);
    const [disagreed, approved] = await race(
      w,
      s.subject.employeeId,
      (world) => world.taskAction(s.inHrbp.userId, hrbp.id, 'disagree', view.revision),
      (world) => world.taskAction(s.inHead.userId, head.id, 'approve', view.revision),
    );
    expect(disagreed).toMatchObject({ status: 200 });
    expect(approved!.status).toBe(409);
    expect(approved!.reason).not.toBe('APPROVAL_CONCURRENT_CONFLICT');
    const after = await w.detail(view.id);
    expect(after).toMatchObject({ status: 'disapproved', currentNodeKey: null });
    expect(after.tasks.find((task) => task.id === head.id)).toMatchObject({ status: 'ended' });
    expect(await settlement(w, view.id)).toEqual({ flows: 1, finals: 0, returns: 0 });
  });
});
