/**
 * F-069 真 PostgreSQL 锁交错（#151 F-065 第 2 轮审查存量 P2；PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）：
 * 全局停用 × 调动接管 × 入职首次绑定。org/locks.ts 全局锁序里账号行排在组织锁之后：入职绑定是“员工 → 组织 → 账号行 FOR SHARE”，
 * 全局停用若先持账号行 NO KEY UPDATE 再进入调动接管（openRun → employmentAdapter.lock → lockEstablishment 取组织锁），
 * 就与持组织锁等账号行的入职互等，PostgreSQL 判 40P01、入职 500。修复：停用在取账号行锁之前先按全局顺序取齐
 * 员工 / 业务 / 组织锁（platform-ops 的停用预取挂接点）。
 * - 停用先：全局停用在员工锁上排队时，入职绑定同一账号；放行后两边都完成，无死锁、不 500；
 * - 绑定先：入职持组织锁、已锁账号行时，全局停用排在组织锁后面；放行后两边都完成，无死锁；
 * 两个方向的结果都正确：来源账号已绑定到入职员工，调动异常待办已转给替代人。
 * 非调动的停用接管见 AC-APV-F065-handover-binding-lock（organization:false 不回退）。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import {
  createUser,
  getUser,
  grantMembership,
  revokeMembership,
  RevisionConflictError,
  setUserStatus,
  sql,
  withPlatform,
  withTenant,
  type Tx,
} from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, transferScene } from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';
import { NODES, pendingOf, rowsOf } from './support/f048.js';
import { settledOrBlocked, waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

/**
 * 夹具：外部账号 U 持有一张调动申请的异常待办（调动需组织锁与编制锁），其流程已作废（否则 DEC-098 拒绝停用）；
 * 另有待入职员工，入职按 U 的登录邮箱首次绑定（取 U 的账号行 FOR SHARE）。
 */
async function scene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  const email = `${label}-${randomUUID()}@example.com`;
  const source = await createUser(w.db, { email, displayName: '外部异常管理员' }, cmd());
  await grantMembership(w.db, { tenantId: w.tenant.id, userId: source.id, expectedRevision: 0 }, cmd());
  const process = await w.publishedProcess({ nodes: [NODES.outHead, NODES.inHrbp], exceptionAdminUserId: source.id });
  await w.setOrgRoles(s.to, { hrbp: null });
  const init = await w.member('发起人');
  const draft = await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: init });
  let view = await w.submit(draft, init);
  view = await w.json(await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision));
  expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: source.id })]);
  await w.json(
    await w.request(w.hr.id, 'POST', `/api/tenant/approval/processes/${process.id}/discard`, {
      ifMatch: process.revision,
    }),
  );
  // 指定替代人（可信夹具直写，不经交接入口：交接会把待办一并转走）：停用接管把待办转给替代人
  const successor = await w.member('替代人');
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO approval_exception_admin_successors
      (tenant_id,user_id,successor_user_id,designated_by,command_id)
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

type Scene = Awaited<ReturnType<typeof scene>>;

/** 两个请求都成功：入职绑定了来源账号、账号已停用、调动异常待办转给了替代人。 */
async function expectBothDone(f: Scene, disabled: unknown, hired: Response) {
  expect(disabled).toBe('ok');
  expect(hired.status, await hired.clone().text()).toBe(201);
  const link = await withTenant(
    f.w.db,
    f.w.tenant.id,
    async (tx) =>
      rowsOf<{ employee_id: string }>(
        await tx.execute(sql`SELECT employee_id FROM permission_user_person_links
        WHERE tenant_id=${f.w.tenant.id} AND user_id=${f.source.id}::uuid`),
      )[0],
  );
  expect(link?.employee_id).toBe(f.target.id);
  expect((await getUser(f.w.db, f.source.id))?.status).toBe('disabled');
  expect(pendingOf(await f.w.detail(f.view.id))).toEqual([expect.objectContaining({ assigneeUserId: f.successor })]);
}

describe.runIf(realPostgres)(
  'AC-APV F-069 全局停用 × 调动接管 × 首次绑定的锁序（DEC-196，账号行排在组织锁之后）',
  () => {
    it('停用先：全局停用在员工锁上排队时，入职绑定同一账号；放行后不死锁、不 500，两边都完成', async () => {
      const f = await scene('f069-disable-first');
      let disabled: Promise<unknown> = Promise.resolve();
      let hired: Promise<Response> = Promise.resolve(new Response());
      await withTenant(f.w.db, f.w.tenant.id, async (barrier) => {
        await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${f.w.tenant.id} AND id=${f.s.subject.employeeId}::uuid FOR UPDATE`);
        disabled = f.disable();
        await waitForBlocked(f.w.db, 1);
        hired = f.hireWithSource();
        // 修复前：停用已持账号行锁、在员工锁上排队；入职持组织锁等账号行，放行后停用取组织锁与之成环（40P01）
        // 修复后：停用尚未持账号行锁，入职直接完成
        await settledOrBlocked(f.w.db, hired, 2);
      });
      await expectBothDone(f, await disabled, await hired);
    });

    it('绑定先：入职持组织锁、已锁账号行时，全局停用排在后面；放行后两边都完成，无死锁', async () => {
      const f = await scene('f069-bind-first');
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
      await expectBothDone(f, await disabled, await hired);
    });

    it('预取之后新增有效成员：重新激活 + 自然推进出新待办 + 并发入职绑定；停用取得账号锁后发现未预取的租户,回滚并要求显式重提', async () => {
      const f = await reactivationScene('f069-reactivate');
      const { w } = f;
      // 屏障 B(账号行 FOR SHARE)挡住停用的账号锁;屏障 M(成员行)让重新激活停在“已持账号行 SHARE、等成员行”。
      const accountHold = hold(w.db, null, sql`SELECT id FROM users WHERE id=${f.source.id}::uuid FOR SHARE`);
      await accountHold.ready;
      const memberHold = hold(
        w.db,
        w.tenant.id,
        sql`SELECT id FROM tenant_memberships
        WHERE tenant_id=${w.tenant.id} AND user_id=${f.source.id}::uuid FOR UPDATE`,
      );
      await memberHold.ready;
      const regranted = outcomeOf(f.regrant());
      await waitForBlocked(w.db, 1);
      // 此刻 U 在 R 的成员关系仍是已撤销:预取扫描跳过 R;停用排在账号锁上(等 B 与重新激活的 SHARE)
      const disabled = f.disable();
      await waitForBlocked(w.db, 2);
      await memberHold.release();
      expect(await regranted).toBe('ok');
      // R 的前置节点同意:U 又是有效成员,调动异常待办自然派到 U 名下
      const approved = await w.taskAction(f.s.outHead.userId, f.pendingTaskId, 'approve', f.view.revision);
      expect(approved.status, await approved.clone().text()).toBe(200);
      expect(pendingOf(await w.detail(f.view.id))).toEqual([expect.objectContaining({ assigneeUserId: f.source.id })]);
      // 屏障 G 停住修复前的第二轮接管(它第一步就取 U 在 R 的派单闸)
      const gateHold = hold(
        w.db,
        w.tenant.id,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(
        'approval-assignee:' || ${w.tenant.id}::uuid::text || ':' || ${f.source.id}::uuid::text, 0))`,
      );
      await gateHold.ready;
      await accountHold.release();
      // 修复前:停用已持账号行锁,停在 R 的派单闸;修复后:账号锁到手即发现 R 未被预取,立即回滚
      await settledOrBlocked(w.db, disabled, 1);
      const hired = f.hireWithSource();
      // 修复前:入职持 R 的组织锁,等停用持有的账号行;放行后停用取 R 的组织锁成环(40P01)
      await settledOrBlocked(w.db, hired, 2);
      await gateHold.release();
      expect(await disabled).toBeInstanceOf(RevisionConflictError);
      const response = await hired;
      expect(response.status, await response.clone().text()).toBe(201);
      // 回滚:账号仍 active,待办仍在 U 名下
      expect((await getUser(w.db, f.source.id))?.status).toBe('active');
      expect(pendingOf(await w.detail(f.view.id))).toEqual([expect.objectContaining({ assigneeUserId: f.source.id })]);
      // 显式重提:这次 R 已在预取覆盖内,停用完成,待办转给替代人
      expect(await f.disable()).toBe('ok');
      expect((await getUser(w.db, f.source.id))?.status).toBe('disabled');
      expect(pendingOf(await w.detail(f.view.id))).toEqual([expect.objectContaining({ assigneeUserId: f.successor })]);
    });
  },
);

function outcomeOf(command: Promise<unknown>): Promise<unknown> {
  return command.then(
    () => 'ok',
    (error: unknown) => error,
  );
}

/** 长事务屏障:执行一条加锁语句后一直持有,直到 release;tenantId 为 null 时用平台角色(可读 users)。 */
function hold(db: Parameters<typeof withTenant>[0], tenantId: string | null, statement: ReturnType<typeof sql>) {
  let release!: () => void;
  let ready!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const readied = new Promise<void>((resolve) => (ready = resolve));
  const run = async (tx: Tx) => {
    await tx.execute(statement);
    ready();
    await released;
  };
  const done = tenantId === null ? withPlatform(db, run) : withTenant(db, tenantId, run);
  void done.catch(() => ready());
  return {
    ready: readied,
    release: async () => {
      release();
      await done;
    },
  };
}

/**
 * 夹具:U 在租户 R 的成员关系已撤销,R 有冻结在“以 U 为异常管理员”版本上的在途调动单 I1(停在第一节点,尚无 U 的待办),
 * 流程已交接给替代人(指定了替代人,DEC-098 允许撤销 / 停用)。重新激活 U 后同意第一节点,调动异常待办自然派给 U。
 */
async function reactivationScene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
  const email = `${label}-${randomUUID()}@example.com`;
  const source = await createUser(w.db, { email, displayName: '外部异常管理员' }, cmd());
  await grantMembership(w.db, { tenantId: w.tenant.id, userId: source.id, expectedRevision: 0 }, cmd());
  await w.setOrgRoles(s.to, { hrbp: null });
  await w.publishedProcess({ exceptionAdminUserId: source.id, nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
  const init = await w.member('发起人');
  const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: init }), init);
  const successor = await w.member('替代人');
  await w.json(
    await w.request(w.hr.id, 'POST', '/api/tenant/approval/exception-admins/handover', {
      ifMatch: 0,
      body: { fromUserId: source.id, toUserId: successor },
    }),
  );
  const membership = async () =>
    Number(
      rowsOf<{ revision: number }>(
        await withTenant(w.db, w.tenant.id, (tx) =>
          tx.execute(sql`SELECT revision FROM tenant_memberships
            WHERE tenant_id=${w.tenant.id} AND user_id=${source.id}::uuid`),
        ),
      )[0]!.revision,
    );
  await revokeMembership(
    w.db,
    { tenantId: w.tenant.id, userId: source.id, expectedRevision: await membership() },
    cmd(),
  );
  const revoked = await membership();
  const target = await w.employee('待绑定员工');
  return {
    w,
    s,
    source,
    successor,
    view,
    pendingTaskId: pendingOf(view)[0]!.id,
    regrant: () =>
      grantMembership(w.db, { tenantId: w.tenant.id, userId: source.id, expectedRevision: revoked }, cmd()),
    disable: async () =>
      outcomeOf(
        setUserStatus(
          w.db,
          { userId: source.id, status: 'disabled', expectedRevision: (await getUser(w.db, source.id))!.revision },
          cmd(),
        ),
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
