/**
 * F-065 真 PostgreSQL 锁交错（#145 第 2 轮审查存量 P2；PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）：
 * 异常管理员交接与入职首次绑定对“来源账号 U”的锁序必须一致（org/locks.ts 全局锁序：员工 → 业务 → 组织 → 编制 → 审批实例，
 * 成员行排在组织锁之后）。反例：交接先登记来源账号（外键对 U 的成员行取 KEY SHARE），再在逐单加锁时等组织锁；
 * 入职绑定 U 已持组织锁、在等成员行 FOR UPDATE——两边互等，PostgreSQL 判死锁，交接被映射成 409 APPROVAL_CONCURRENT_CONFLICT。
 * - 绑定先：交接被员工锁挡住时，绑定 U 的入职不被交接挡住；放行后两边都成功；
 * - 交接先：交接持着组织锁等实例锁时，绑定 U 的入职排在后面；放行后两边都成功；
 * 两个方向都不死锁、结果正确（来源账号已绑定到入职员工，替代人生效，异常待办已转给替代人）。
 * 冻结语义不变（DEC-329⑤，冻结后的首次绑定不追溯）：见 AC-APV-F048-pg-interleave。
 */
import { randomUUID } from 'node:crypto';
import { createUser, getUser, grantMembership, setUserStatus, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';
import { NODES, pendingOf, rowsOf } from './support/f048.js';
import { settledOrBlocked, waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

/** 异常管理员 U 是已有成员关系的外部账号：入职按其登录邮箱绑定时取其成员行 FOR UPDATE（DEC-158）。 */
async function scene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  const email = `${label}-${randomUUID()}@example.com`;
  const source = await createUser(w.db, { email, displayName: '外部异常管理员' }, cmd());
  await grantMembership(w.db, { tenantId: w.tenant.id, userId: source.id, expectedRevision: 0 }, cmd());
  await w.publishedProcess({ nodes: [NODES.outHead, NODES.inHrbp], exceptionAdminUserId: source.id });
  await w.setOrgRoles(s.to, { hrbp: null });
  const init = await w.member('发起人');
  const draft = await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: init });
  let view = await w.submit(draft, init);
  view = await w.json(await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision));
  expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: source.id })]);
  const successor = await w.member('替代人');
  const target = await w.employee('待绑定员工');
  return {
    w,
    s,
    view,
    source,
    successor,
    handover: () =>
      w.request(w.hr.id, 'POST', '/api/tenant/approval/exception-admins/handover', {
        ifMatch: 0,
        body: { fromUserId: source.id, toUserId: successor },
      }),
    hireWithSource: () =>
      w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${target.id}/businesses`, {
        ifMatch: target.revision,
        body: {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2020-01-01',
          fields: { departmentId: s.from },
          loginEmail: email,
        },
      }),
    target,
  };
}

type Scene = Awaited<ReturnType<typeof scene>>;

/** 两个请求都成功，且交接与绑定的结果都落地。 */
async function expectBothDone(f: Scene, handed: Response, hired: Response) {
  expect(handed.status, await handed.clone().text()).toBe(200);
  expect(hired.status, await hired.clone().text()).toBe(201);
  const { link, designated } = await withTenant(f.w.db, f.w.tenant.id, async (tx) => ({
    link: rowsOf<{ employee_id: string }>(
      await tx.execute(sql`SELECT employee_id FROM permission_user_person_links
        WHERE tenant_id=${f.w.tenant.id} AND user_id=${f.source.id}::uuid`),
    )[0],
    designated: rowsOf<{ successor_user_id: string }>(
      await tx.execute(sql`SELECT successor_user_id FROM approval_exception_admin_successors
        WHERE tenant_id=${f.w.tenant.id} AND user_id=${f.source.id}::uuid`),
    )[0],
  }));
  expect(link?.employee_id).toBe(f.target.id);
  expect(designated?.successor_user_id).toBe(f.successor);
  const moved = await f.w.json<InstanceView>(
    await f.w.request(f.w.hr.id, 'GET', `/api/tenant/approval/instances/${f.view.id}`),
  );
  expect(pendingOf(moved)).toEqual([expect.objectContaining({ assigneeUserId: f.successor })]);
}

describe.runIf(realPostgres)('AC-APV F-065 交接与首次绑定的锁序（DEC-196 全局锁序，反向锁环）', () => {
  it('绑定先：交接在员工锁上排队时，入职绑定来源账号；放行后两边都完成，无死锁', async () => {
    const f = await scene('f065-bind-first');
    let handedOver: Promise<Response> = Promise.resolve(new Response());
    let hired: Promise<Response> = Promise.resolve(new Response());
    await withTenant(f.w.db, f.w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${f.w.tenant.id} AND id=${f.s.subject.employeeId}::uuid FOR UPDATE`);
      handedOver = f.handover();
      await waitForBlocked(f.w.db, 1);
      hired = f.hireWithSource();
      // 修复前：交接已登记来源账号（持成员行 KEY SHARE），绑定持组织锁等成员行；修复后交接尚未持有任何成员行锁，绑定直接完成
      await settledOrBlocked(f.w.db, hired, 2);
    });
    await expectBothDone(f, await handedOver, await hired);
  });

  it('交接先：交接持着组织锁等实例锁时，入职绑定来源账号排在后面；放行后两边都完成，无死锁', async () => {
    const f = await scene('f065-handover-first');
    let handedOver: Promise<Response> = Promise.resolve(new Response());
    let hired: Promise<Response> = Promise.resolve(new Response());
    await withTenant(f.w.db, f.w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM approval_instances
        WHERE tenant_id=${f.w.tenant.id} AND id=${f.view.id}::uuid FOR UPDATE`);
      handedOver = f.handover();
      await waitForBlocked(f.w.db, 1);
      hired = f.hireWithSource();
      await waitForBlocked(f.w.db, 2);
    });
    await expectBothDone(f, await handedOver, await hired);
  });
});

const LEAVE_CONDITION = { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] };

/**
 * 停用接管夹具：未绑定人员的外部账号 U 持有一张离职申请（非调动任职业务）的异常待办；另有待入职员工，入职时按 U 的登录邮箱
 * 首次绑定（取 U 的账号行 FOR SHARE）。全局停用 U 先持其账号行 NO KEY UPDATE，再进入停用接管。
 */
async function leaveScene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  const email = `${label}-${randomUUID()}@example.com`;
  const source = await createUser(w.db, { email, displayName: '外部异常管理员' }, cmd());
  await grantMembership(w.db, { tenantId: w.tenant.id, userId: source.id, expectedRevision: 0 }, cmd());
  await w.setOrgRoles(s.from, { hrbp: null });
  const process = await w.publishedProcess({
    approvalType: 'leave',
    conditions: LEAVE_CONDITION,
    nodes: [NODES.outHead, { key: 'hrbp', approver: 'record_department_hrbp' }],
    exceptionAdminUserId: source.id,
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
  let view = await w.submit(created);
  view = await w.json(await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision));
  expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: source.id })]);
  // 仍是可用流程的异常管理员时拒绝停用（DEC-098）：作废流程，在途实例按冻结版本继续，待办仍在 U 名下
  await w.json(
    await w.request(w.hr.id, 'POST', `/api/tenant/approval/processes/${process.id}/discard`, {
      ifMatch: process.revision,
    }),
  );
  // 指定替代人（可信夹具直写，不经交接入口：交接会把待办一并转走）：停用接管把待办转给替代人
  const successor = await w.member('替代人');
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO approval_exception_admin_successors (tenant_id,user_id,successor_user_id,designated_by,command_id)
      VALUES (${w.tenant.id},${source.id}::uuid,${successor}::uuid,${w.hr.id}::uuid,${randomUUID()})`),
  );
  const target = await w.employee('待绑定员工');
  const user = await getUser(w.db, source.id);
  return {
    w,
    s,
    view,
    source,
    successor,
    target,
    disable: () =>
      setUserStatus(w.db, { userId: source.id, status: 'disabled', expectedRevision: user!.revision }, cmd()).then(
        () => 'ok',
        (error: unknown) => error,
      ),
    hireWithSource: () =>
      w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${target.id}/businesses`, {
        ifMatch: target.revision,
        body: {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2020-01-01',
          fields: { departmentId: s.from },
          loginEmail: email,
        },
      }),
  };
}

describe.runIf(realPostgres)('AC-APV F-065 停用接管与首次绑定的锁序（DEC-196，第 2 轮）', () => {
  it('停用先：全局停用在员工锁上排队时（已持账号行锁），入职绑定同一账号；放行后不死锁、不 500', async () => {
    const f = await leaveScene('f065-disable-first');
    let disabled: Promise<unknown> = Promise.resolve();
    let hired: Promise<Response> = Promise.resolve(new Response());
    await withTenant(f.w.db, f.w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${f.w.tenant.id} AND id=${f.s.subject.employeeId}::uuid FOR UPDATE`);
      disabled = f.disable();
      await waitForBlocked(f.w.db, 1);
      hired = f.hireWithSource();
      // 修复前：停用接管预锁组织锁，与持组织锁等账号行的入职互等（40P01）；修复后入职只排在停用后面
      await settledOrBlocked(f.w.db, hired, 2);
    });
    expect(await disabled).toBe('ok');
    const response = await hired;
    expect(response.status, await response.clone().text()).toBeLessThan(500);
    expect(pendingOf(await f.w.detail(f.view.id))).toEqual([expect.objectContaining({ assigneeUserId: f.successor })]);
  });

  it('绑定先：入职绑定持组织锁等账号级串行锁时，全局停用排在后面；放行后两边都完成，无死锁', async () => {
    const f = await leaveScene('f065-bind-first-disable');
    let disabled: Promise<unknown> = Promise.resolve();
    let hired: Promise<Response> = Promise.resolve(new Response());
    await withTenant(f.w.db, f.w.tenant.id, async (barrier) => {
      // 与 provisionEmployeeUser 同一把“同账号并发建档串行”咨询锁：入职已持组织锁、已锁账号行（FOR SHARE），停在这里
      await barrier.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${f.w.tenant.id}:person-link:${f.source.id}`}, 0))`,
      );
      hired = f.hireWithSource();
      await waitForBlocked(f.w.db, 1);
      disabled = f.disable();
      await waitForBlocked(f.w.db, 2);
    });
    const response = await hired;
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await disabled).toBe('ok');
    expect(pendingOf(await f.w.detail(f.view.id))).toEqual([expect.objectContaining({ assigneeUserId: f.successor })]);
  });
});
