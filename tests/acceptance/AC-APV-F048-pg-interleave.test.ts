/**
 * F-048 PR-2 真 PostgreSQL 锁交错（设计 §5.4，测试 T13；PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）：
 * 冻结写入不取员工行 / 成员行的锁，也不新增会等待的锁边——
 * - P3：人员 / 合同模块持集合内非单主体员工行 FOR UPDATE 未提交时，集合实例发起 / 重提冻结不等待；
 * - 冻结语句与并发首次绑定交错：冻结读到语句开始时已提交的绑定，绝不出现半截；
 * - R2-01：交接事务持成员行 KEY SHARE、建档绑定（成员行 FOR UPDATE）在等它时，另一实例重提冻结照常完成，无死锁；
 * - 重提与管理员干预并发：一方成功，另一方 409，不死锁。
 */
import { permissionUserPersonLinks, sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';
import { frozenOf, NODES, pendingOf, reasonOf, rowsOf, useSubjectMapping } from './support/f048.js';

const database = useTestDb();
const mapSubjects = useSubjectMapping();
const BASE = '/api/tenant/approval';
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

async function lockWaiters(db: Db): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
  );
  return Number(row?.n);
}

/** 等到请求结束或恰有 expected 个会话在等锁，返回先发生的那一个。 */
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

async function waitForBlocked(db: Db, expected: number) {
  for (let i = 0; i < 200; i++) {
    if ((await lockWaiters(db)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待 ${expected} 个会话阻塞超时`);
}

async function scene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({ nodes: [NODES.outHead, NODES.inHrbp] });
  return { w, s };
}

/** 驳回并重提，返回重提的请求（调用方决定何时 await）。 */
async function returned(w: ApprovalWorld, s: Awaited<ReturnType<typeof transferScene>>) {
  const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
  const view = await w.submit(draft);
  const back = await w.json<InstanceView>(
    await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'reject', view.revision),
  );
  expect(back.status).toBe('returned');
  const business = await w.business(draft.id);
  return { draft, view: back, resubmit: () => w.submitRaw({ id: draft.id, revision: business.revision }) };
}

describe.runIf(realPostgres)('F-048 冻结与并发写入交错', () => {
  it('P3：持集合内员工行 FOR UPDATE 未提交时，发起 / 重提冻结不等待（先于持锁方提交）', async () => {
    const { w, s } = await scene('f048-pg-p3');
    const member = await w.person('集合成员', s.from);
    mapSubjects(() => [member.employeeId]);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    await withTenant(w.db, w.tenant.id, async (barrier) => {
      const locked = await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.tenant.id} AND id=${member.employeeId}::uuid FOR UPDATE`);
      expect(rowsOf(locked)).toHaveLength(1);
      const start = w.submitRaw(draft);
      expect(await settledOrBlocked(w.db, start, 1)).toBe('settled');
      expect((await start).status).toBe(200);
    });
    const view = await w.instanceOf(draft.id);
    expect((await frozenOf(w, view.id)).map((row) => row.employee_id)).toContain(member.employeeId);

    const back = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'reject', view.revision),
    );
    expect(back.status).toBe('returned');
    const business = await w.business(draft.id);
    await withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.tenant.id} AND id=${member.employeeId}::uuid FOR UPDATE`);
      const resubmit = w.submitRaw({ id: draft.id, revision: business.revision });
      expect(await settledOrBlocked(w.db, resubmit, 1)).toBe('settled');
      expect((await resubmit).status).toBe(200);
    });
    expect((await frozenOf(w, view.id)).filter((row) => row.round === 2).map((row) => row.employee_id)).toContain(
      member.employeeId,
    );
  });

  it('冻结语句与并发首次绑定交错：未提交的绑定不被读到（不等待），提交后的下一轮冻结带上新账号', async () => {
    const { w, s } = await scene('f048-pg-bind');
    const late = await w.employee('并发绑定员工');
    const lateUser = await w.member('并发绑定账号');
    mapSubjects(() => [late.id]);
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    await withTenant(w.db, w.tenant.id, async (binder) => {
      await binder.insert(permissionUserPersonLinks).values({
        tenantId: w.tenant.id,
        userId: lateUser,
        employeeId: late.id,
      });
      const start = w.submitRaw(draft);
      expect(await settledOrBlocked(w.db, start, 1)).toBe('settled');
      expect((await start).status).toBe(200);
    });
    const view = await w.instanceOf(draft.id);
    expect((await frozenOf(w, view.id)).find((row) => row.employee_id === late.id)?.user_id).toBeNull();
    const back = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'reject', view.revision),
    );
    const business = await w.business(draft.id);
    expect(back.status).toBe('returned');
    await w.json(await w.submitRaw({ id: draft.id, revision: business.revision }));
    expect((await frozenOf(w, view.id)).find((row) => row.round === 2 && row.employee_id === late.id)?.user_id).toBe(
      lateUser,
    );
  });

  it('R2-01：交接持成员行 KEY SHARE、建档绑定（成员行 FOR UPDATE）等它时，另一实例重提冻结照常完成，三者无死锁', async () => {
    const { w, s } = await scene('f048-pg-r201');
    const external = await w.member('外部账号');
    const bound = await w.employee('待绑定员工');
    const { resubmit } = await returned(w, s);
    let binding: Promise<unknown> = Promise.resolve();
    await withTenant(w.db, w.tenant.id, async (handover) => {
      await handover.execute(sql`SELECT 1 FROM tenant_memberships WHERE tenant_id=${w.tenant.id}
        AND user_id=${external}::uuid FOR KEY SHARE`);
      binding = withTenant(w.db, w.tenant.id, async (tx) => {
        await tx.execute(sql`SELECT 1 FROM tenant_memberships WHERE tenant_id=${w.tenant.id}
          AND user_id=${external}::uuid FOR UPDATE`);
        await tx.insert(permissionUserPersonLinks).values({
          tenantId: w.tenant.id,
          userId: external,
          employeeId: bound.id,
        });
      });
      await waitForBlocked(w.db, 1);
      mapSubjects(() => [bound.id]);
      const request = resubmit();
      expect(await settledOrBlocked(w.db, request, 2)).toBe('settled');
      expect((await request).status).toBe(200);
      expect(await lockWaiters(w.db)).toBe(1);
    });
    // 交接事务结束后绑定随即完成，三者都已完成
    await binding;
  });
});

describe.runIf(realPostgres)('F-048 重提与管理员干预并发', () => {
  it('同一实例：重提与管理员干预同时排队，一方成功、另一方 409，不死锁；第 2 轮冻结只写一次', async () => {
    const { w, s } = await scene('f048-pg-resubmit-admin');
    const { draft, view, resubmit } = await returned(w, s);
    const admin = await w.member('流程管理员');
    const responses = await withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.tenant.id} AND id=${s.subject.employeeId}::uuid FOR UPDATE`);
      const first = resubmit();
      await waitForBlocked(w.db, 1);
      const second = w.instanceAction(admin, view.id, 'admin-intervene', view.revision, {
        kind: 'jump',
        toNodeKey: 'in_hrbp',
        reason: '并发干预',
      });
      await waitForBlocked(w.db, 2);
      return [first, second] as const;
    });
    const [submitted, intervened] = await Promise.all((await Promise.all(responses)).map(reasonOf));
    expect(submitted).toMatchObject({ status: 200 });
    expect(intervened!.status).toBe(409);
    expect(intervened!.reason).not.toBe('APPROVAL_CONCURRENT_CONFLICT');
    const instance = await w.instanceOf(draft.id);
    expect((await frozenOf(w, instance.id)).filter((row) => row.round === 2)).toHaveLength(1);
  });
});
