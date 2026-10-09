/**
 * F-048 PR-2 真 PostgreSQL 锁交错（设计 §5.4，测试 T13；PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）：
 * 冻结写入不取员工行 / 成员行的锁，也不新增会等待的锁边——
 * - P3：人员 / 合同模块持集合内非单主体员工行 FOR UPDATE 未提交时，集合实例发起 / 重提冻结不等待；
 * - 冻结语句与并发首次绑定交错：冻结读到语句开始时已提交的绑定，绝不出现半截；
 * - 真实交接 × 真实建档绑定 × 重提冻结（R2-01 的无锁边结论）：绑定提交后重提冻结读到它，三者无死锁；
 * - 重提 × 交接批处理：既有组织锁序下排队，放行后都完成。
 * 附记：用同一个来源成员（交接 KEY SHARE）与入职绑定同时交错，会撞上交接（成员 KEY SHARE → 组织锁）与入职（组织锁 → 成员 FOR UPDATE）
 * 的既有锁序差异而死锁，与冻结无关，已在 PR 描述记为存量问题，不在本 PR 改。
 * - 重提与管理员干预并发：一方成功，另一方 409，不死锁。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, permissionUserPersonLinks, sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';
import { frozenOf, NODES, pendingOf, reasonOf, rowsOf, useSubjectMapping } from './support/f048.js';

const database = useTestDb();
const mapSubjects = useSubjectMapping();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const BASE = '/api/tenant/approval';

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

describe.runIf(realPostgres)('F-048 冻结与并发写入交错（DEC-329⑤）', () => {
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

  /**
   * 交接批处理夹具：实例 A（异动员工 S1）停在异常管理员待办上，是交接的对象；实例 B（异动员工 S2）被驳回、可重提。
   * 两者异动员工不同，交接只锁 S1，重提只锁 S2。
   */
  async function handoverPair(label: string) {
    const { w, s } = await scene(label);
    await w.setOrgRoles(s.to, { hrbp: null });
    const init = await w.member('发起人');
    const draftA = await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: init });
    let viewA = await w.submit(draftA, init);
    viewA = await w.json(await w.taskAction(s.outHead.userId, pendingOf(viewA)[0]!.id, 'approve', viewA.revision));
    expect(pendingOf(viewA)).toEqual([expect.objectContaining({ assigneeUserId: w.exceptionAdmin })]);
    // B 调入另一个部门：同一部门的两张单会在业务既有的组织锁上互相等待，与冻结无关
    const third = await w.org('第三部门');
    const other = await w.person('另一异动员工', s.from);
    const draftB = await w.application(other.employeeId, { departmentId: third });
    const viewB = await w.submit(draftB);
    await w.json(await w.taskAction(s.outHead.userId, pendingOf(viewB)[0]!.id, 'reject', viewB.revision));
    const business = await w.business(draftB.id);
    const successor = await w.member('替代人');
    return {
      w,
      s,
      viewA,
      viewB,
      successor,
      resubmitB: () => w.submitRaw({ id: draftB.id, revision: business.revision }),
      handover: () =>
        w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
          ifMatch: 0,
          body: { fromUserId: w.exceptionAdmin, toUserId: successor },
        }),
    };
  }

  it('真实交接 × 真实建档绑定 × 重提冻结：交接排在员工锁后，绑定先完成，重提冻结读到已提交的绑定，三者无死锁', async () => {
    const { w, s, handover, resubmitB, viewB } = await handoverPair('f048-pg-r201');
    // 另一个外部账号（已有成员关系、已知登录邮箱）；入职时按登录邮箱绑定它（DEC-158），取其成员行 FOR UPDATE
    const external = await createUser(
      w.db,
      { email: `f048-ext-${randomUUID()}@example.com`, displayName: '外部账号' },
      cmd(),
    );
    await grantMembership(w.db, { tenantId: w.tenant.id, userId: external.id, expectedRevision: 0 }, cmd());
    const target = await w.employee('待绑定员工');
    let handedOver: Promise<Response> = Promise.resolve(new Response());
    await withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.tenant.id} AND id=${s.subject.employeeId}::uuid FOR UPDATE`);
      handedOver = handover();
      await waitForBlocked(w.db, 1);
      const binding = w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${target.id}/businesses`, {
        ifMatch: target.revision,
        body: {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2020-01-01',
          fields: { departmentId: s.from },
          loginEmail: external.email,
        },
      });
      expect(await settledOrBlocked(w.db, binding, 2)).toBe('settled');
      expect((await binding).status, await (await binding).clone().text()).toBe(201);
      mapSubjects(() => [target.id]);
      const resubmit = resubmitB();
      expect(await settledOrBlocked(w.db, resubmit, 2)).toBe('settled');
      expect((await resubmit).status).toBe(200);
    });
    const handed = await handedOver;
    expect(handed.status, await handed.clone().text()).toBe(200);
    expect((await frozenOf(w, viewB.id)).find((row) => row.round === 2 && row.employee_id === target.id)?.user_id).toBe(
      external.id,
    );
  });

  it('重提 × 交接批处理：交接持着员工锁与组织锁等实例锁，重提排在后面；放行后两者都完成，无死锁，冻结写一次', async () => {
    const { w, s, viewA, handover, resubmitB, viewB } = await handoverPair('f048-pg-batch');
    mapSubjects(() => [s.subject.employeeId]);
    let requests: Promise<Response>[] = [];
    await withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM approval_instances
        WHERE tenant_id=${w.tenant.id} AND id=${viewA.id}::uuid FOR UPDATE`);
      const handedOver = handover();
      await waitForBlocked(w.db, 1);
      // 任职申请的重提要取租户级组织锁（既有锁序：员工 → 业务 → 组织 → 编制 → 审批实例），排在交接之后；冻结本身不加锁
      const resubmit = resubmitB();
      await waitForBlocked(w.db, 2);
      requests = [handedOver, resubmit];
    });
    const [handed, resubmitted] = await Promise.all(requests);
    expect(handed!.status, await handed!.clone().text()).toBe(200);
    expect(resubmitted!.status, await resubmitted!.clone().text()).toBe(200);
    const round2 = (await frozenOf(w, viewB.id)).filter((row) => row.round === 2);
    expect(round2.filter((row) => row.employee_id === s.subject.employeeId)).toHaveLength(1);
  });
});

describe.runIf(realPostgres)('F-048 重提与管理员干预并发（DEC-329⑤）', () => {
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
    // 重提先拿到锁并推进了 revision，排在后面的管理员干预带着旧 revision → 409 REVISION_CONFLICT（不是死锁映射的并发冲突）
    expect(intervened).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    const instance = await w.instanceOf(draft.id);
    expect((await frozenOf(w, instance.id)).filter((row) => row.round === 2)).toHaveLength(1);
  });
});
