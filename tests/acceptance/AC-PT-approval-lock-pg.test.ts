/**
 * AC-PT-approval-lock-pg（PB-80，docs/08_设计/R2-T05_兼职设计.md §4.5A；真 PostgreSQL，PGlite 单连接无法并发，只在设了
 * TEST_DATABASE_URL 时运行）：兼职新增申请的同意 / 接管可能落地，落地要取组织锁（部门可用性 D-7），所以适配器必须在锁实例、
 * 登记替代人 / 锁账号行之前先取组织锁（全局锁序 员工 → 业务头 → 组织 → 实例，成员行 / 账号行排在组织锁之后，F-065）。
 * 否则与“入职绑定账号：组织锁 → 成员行 / 账号行”成环（40P01，会被映射成并发冲突）。
 * 组织锁是租户级排他锁，双方不能同时越过它，所以屏障按“先 B 后 A”编排：
 * ① 事务 B（入职绑定路径）先取组织锁并停住；② 启动 A；③ 轮询 pg_stat_activity 断言 A 在组织锁上等待（wait_event_type = 'Lock'），
 * 且此时 A 还没锁实例 / 账号行（B 在另一事务里 NOWAIT 取这两把锁必须成功）；④ 放行 B；⑤ A 完成，结果与串行一致，没有 40P01。
 * 若把适配器 lock / lockMany 的加锁顺序改错（实例或账号行先于组织锁），③ 的 NOWAIT 取锁失败，测试必红。
 */
import { randomUUID } from 'node:crypto';
import { getUser, setUserStatus, sql, withPlatform, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
import { bootstrapTenantAdmin } from '@italent/api';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { requestWorld } from './AC-PT-request-support.js';
import { cmd } from './support/tenant-api.js';
import { pendingOf } from './support/f048.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

/** 在另一个事务里 NOWAIT 取锁：取得返回 'free'，已被别的事务持有（55P03）返回 'held'。 */
async function probe(db: Db, statement: ReturnType<typeof sql>, platform = false) {
  const run = (tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }) => tx.execute(statement);
  try {
    await (platform ? withPlatform(db, run) : withTenant(db, TENANT.value, run));
    return 'free';
  } catch (error) {
    const failure = error as { code?: string; cause?: { code?: string } };
    const code = failure.code ?? failure.cause?.code;
    if (code === '55P03') return 'held';
    throw error;
  }
}
const TENANT = { value: '' };

/** 外部异常管理员 U 名下有一张兼职新增申请的异常待办（主职负责人为空，第二节点转异常管理员，F-165③）。 */
async function scene(label: string) {
  const db = database().db;
  const w = await requestWorld(db, label, { noPrimaryHead: true, externalExceptionAdmin: true });
  const source = w.external!;
  TENANT.value = w.tenant.id;
  const created = await w.create({ endDate: '2026-12-31' });
  await w.send(created.id, 1);
  await w.decide(created.id, w.approvers.pHrbp, 'approve');
  const view = await w.instance(created.id);
  expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: source.id })]);
  return { db, w, source, created, view };
}

describe.runIf(realPostgres)('AC-PT-approval-lock-pg PB-80 适配器资源预锁（先组织锁，再实例 / 账号行）', () => {
  it('全局停用接管（lockMany，organization = true）：B 持组织锁时 A 在组织锁上等待、尚未锁账号行；放行后两边完成，无死锁', async () => {
    const { db, w, source, view } = await scene('pt-lock-many');
    // DEC-098：仍是可用流程的异常管理员时拒绝停用——作废流程，在途实例按冻结版本继续；替代人由可信夹具直写
    const processes = await w.json<{ items: { id: string; revision: number }[] }>(
      await w.request(w.hr.id, 'GET', '/api/tenant/approval/processes?approvalType=part_time_add'),
    );
    const process = processes.items[0]!;
    await w.json(
      await w.request(w.hr.id, 'POST', `/api/tenant/approval/processes/${process.id}/discard`, {
        ifMatch: process.revision,
      }),
    );
    const successor = await w.member('替代人');
    await withTenant(db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO approval_exception_admin_successors
        (tenant_id,user_id,successor_user_id,designated_by,command_id)
        VALUES (${w.tenant.id},${source.id}::uuid,${successor}::uuid,${w.hr.id}::uuid,${randomUUID()})`),
    );
    const user = await getUser(db, source.id);
    const disable = () =>
      setUserStatus(db, { userId: source.id, status: 'disabled', expectedRevision: user!.revision }, cmd()).then(
        () => 'ok',
        (error: unknown) => error,
      );
    let disabled: Promise<unknown> = Promise.resolve();
    await withTenant(db, w.tenant.id, async (barrier) => {
      await lockOrganizationSettings(barrier, w.tenant.id); // B：入职绑定路径先取组织锁，随后才会去锁成员 / 账号行
      disabled = disable();
      await waitForBlocked(db, 1);
      // A 已在等待，且还没锁账号行：另一个事务能 NOWAIT 取到 users 行。若把组织锁挪到账号行之后，这里必为 'held'
      expect(
        await probe(db, sql`SELECT id FROM users WHERE id=${source.id}::uuid FOR NO KEY UPDATE NOWAIT`, true),
      ).toBe('free');
    });
    expect(await disabled, '停用接管不得被映射成并发冲突（40P01）').toBe('ok');
    expect(pendingOf(await w.detail(view.id))).toEqual([expect.objectContaining({ assigneeUserId: successor })]);
  });

  it('单个同意（lock）：B 持组织锁时 A 在适配器 lock 的组织锁上等待，早于锁实例；放行后同意完成、状态推进', async () => {
    const w = await requestWorld(database().db, 'pt-lock-single');
    TENANT.value = w.tenant.id;
    const created = await w.create({ endDate: '2026-12-31' });
    await w.send(created.id, 1);
    const view = await w.instance(created.id);
    const task = pendingOf(view)[0]!;
    let approving: Promise<Response> = Promise.resolve(new Response());
    await withTenant(w.db, w.tenant.id, async (barrier) => {
      await lockOrganizationSettings(barrier, w.tenant.id);
      approving = w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, { comment: '同意' });
      await waitForBlocked(w.db, 1);
      // 同意还没锁实例：若实例锁先于组织锁，另一事务 NOWAIT 取实例行必为 'held'
      expect(
        await probe(w.db, sql`SELECT id FROM approval_instances WHERE id=${view.id}::uuid FOR UPDATE NOWAIT`),
      ).toBe('free');
    });
    const response = await approving;
    expect(response.status, await response.clone().text()).toBe(200);
    expect(pendingOf(await w.instance(created.id))[0]!.assigneeUserId).toBe(w.approvers.pHead.userId);
  });
});

/**
 * #433 第 1 轮 P2-1：手动交接（reassignFrom）单人节点、无会签合席时不会推进业务，适配器 lock 不得取组织锁 —— 否则交接已登记
 * 替代人（来源 / 替代人成员行 KEY SHARE）再回头等组织锁，与入职绑定的“组织锁 → 成员行 FOR UPDATE”成环。
 * 屏障：B 持组织锁 → 启动交接 A → A 必须不在组织锁上等（waitForBlocked 不成立则 A 已结束）；B 再取来源成员行 FOR UPDATE 不得死锁。
 * 新增（add）与延长（extend）同一个适配器入口，两个都测；结束（end）本就不取组织锁。
 */
describe.runIf(realPostgres)('AC-PT-approval-lock-pg #433 P2-1 手动交接 × 入职绑定强制交错', () => {
  for (const kind of ['add', 'extend'] as const) {
    it(`${kind}：交接仅改派不取组织锁——B 持组织锁并随后取来源成员行，两边都完成，无死锁，交接 200`, async () => {
      const w = await requestWorld(database().db, `pt433-handover-${kind}`, {
        noPrimaryHead: true,
        externalExceptionAdmin: true,
      });
      const source = kind === 'add' ? w.external!.id : w.exceptionAdmin;
      const api = w.http();
      const created =
        kind === 'add'
          ? await w.ok(await api.create({ endDate: '2026-12-31' }), 201)
          : await w.ok(
              await api.createDate({
                requestType: 'extend',
                recordId: await w.seedRecord(),
                endDate: '2026-12-31',
              }),
              201,
            );
      await w.ok(await api.act(created.id, 'submit', created.revision));
      await w.decide(created.id, w.approvers.pHrbp, 'approve');
      expect(w.pending(await w.instance(created.id))[0]!.assigneeUserId).toBe(source);
      const admin = await w.member('交接操作员');
      await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: admin }, cmd());
      const successor = await w.member('替代人');
      const deadlocksBefore = await deadlocks(w.db);
      let handover: Promise<Response> = Promise.resolve(new Response());
      const blocker = await withTenant(w.db, w.tenant.id, async (tx) => {
        await tx.execute(sql`SELECT tenant_id FROM org_settings WHERE tenant_id=${w.tenant.id} FOR UPDATE`);
        handover = w.request(admin, 'POST', '/api/tenant/approval/exception-admins/handover', {
          ifMatch: 0,
          body: { fromUserId: source, toUserId: successor },
        });
        // 交接要么已经结束（没有等组织锁），要么正等别的锁；给它足够时间走到登记替代人（成员行 KEY SHARE）
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await tx.execute(
          sql`SELECT user_id FROM tenant_memberships WHERE tenant_id=${w.tenant.id} AND user_id=${source}::uuid FOR UPDATE`,
        );
        return 'ok';
      }).catch((error: { code?: string; cause?: { code?: string } }) => error.code ?? error.cause?.code ?? 'error');
      const response = await handover;
      expect({
        blocker,
        status: response.status,
        body: response.status === 200 ? null : await response.text(),
      }).toEqual({
        blocker: 'ok',
        status: 200,
        body: null,
      });
      expect(await deadlocks(w.db)).toBe(deadlocksBefore);
    });
  }
});

/**
 * 延长申请手动交接的组织锁范围（F-070 同口径，DEC-431① 单一判定 mayAdvanceBusiness）：交接排队等实例锁时（已完成全部预锁），
 * 仅改派 → 不持组织锁；替代人已占本节点一席（会签合席）→ 仍持组织锁，守住合席结算 / 落地的保护。
 */
describe.runIf(realPostgres)('AC-PT-approval-lock-pg #433 P2-1 延长申请交接的组织锁范围', () => {
  async function extendHandover(label: string, countersign: boolean) {
    const w = await requestWorld(database().db, label, { noPrimaryHead: true, countersign });
    const api = w.http();
    const created = await w.ok(
      await api.createDate({
        requestType: 'extend',
        recordId: await w.seedRecord(),
        endDate: '2026-12-31',
        submit: true,
      }),
      201,
    );
    await w.decide(created.id, w.approvers.pHrbp, 'approve');
    const view = await w.instance(created.id);
    expect(pendingOf(view)).toEqual(
      expect.arrayContaining([expect.objectContaining({ assigneeUserId: w.exceptionAdmin })]),
    );
    const admin = await w.member('交接操作员');
    await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: admin }, cmd());
    const successor = countersign ? w.approvers.pHrbp.userId : await w.member('替代人');
    let handed: Promise<Response> = Promise.resolve(new Response());
    let free = false;
    await withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM approval_instances
        WHERE tenant_id=${w.tenant.id} AND id=${view.id}::uuid FOR UPDATE`);
      handed = w.request(admin, 'POST', '/api/tenant/approval/exception-admins/handover', {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor },
      });
      await waitForBlocked(w.db, 1);
      free = await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT tenant_id FROM org_settings WHERE tenant_id=${w.tenant.id} FOR UPDATE NOWAIT`),
      ).then(
        () => true,
        (error: { code?: string; cause?: { code?: string } }) => {
          if ((error.code ?? error.cause?.code) !== '55P03') throw error;
          return false;
        },
      );
    });
    const response = await handed;
    expect(response.status, await response.clone().text()).toBe(200);
    return free;
  }

  it('仅改派（单人节点）：交接排队时不持组织锁，普通组织写入不被挡住', async () => {
    expect(await extendHandover('pt433-extend-reassign-only', false)).toBe(true);
  });

  it('会签合席（替代人已占本节点一席）：交接排队时仍持组织锁', async () => {
    expect(await extendHandover('pt433-extend-merge-seat', true)).toBe(false);
  });

  it('成员撤销接管合席结算（lock，无 lockMany 预锁）：等组织锁期间尚未持有实例锁（锁序 组织 → 实例），放行后接管完成', async () => {
    const w = await requestWorld(database().db, 'pt433-extend-revoke-settle', {
      noPrimaryHead: true,
      countersign: true,
      externalExceptionAdmin: 'extend',
    });
    const source = w.external!.id;
    const created = await w.ok(
      await w.http().createDate({
        requestType: 'extend',
        recordId: await w.seedRecord(),
        endDate: '2026-12-31',
        submit: true,
      }),
      201,
    );
    await w.decide(created.id, w.approvers.pHrbp, 'approve');
    const view = await w.instance(created.id);
    expect(pendingOf(view)).toEqual(expect.arrayContaining([expect.objectContaining({ assigneeUserId: source })]));
    // 仍是可用流程的异常管理员时拒绝移除（DEC-098）：作废该流程，在途实例按冻结版本继续
    const processes = await w.json<{ items: { id: string; revision: number }[] }>(
      await w.request(w.hr.id, 'GET', '/api/tenant/approval/processes?approvalType=part_time_extend'),
    );
    const process = processes.items[0]!;
    await w.json(
      await w.request(w.hr.id, 'POST', `/api/tenant/approval/processes/${process.id}/discard`, {
        ifMatch: process.revision,
      }),
    );
    // 发起人 HR 把 U 的任务交接给已占席位的主职HRBP：实例因本人发起被跳过，但替代人已登记，成员撤销时接管会合席结算
    const handover = await w.json<{ skipped: { instanceId: string }[] }>(
      await w.request(w.hr.id, 'POST', '/api/tenant/approval/exception-admins/handover', {
        ifMatch: 0,
        body: { fromUserId: source, toUserId: w.approvers.pHrbp.userId },
      }),
    );
    expect(handover.skipped.map((item) => item.instanceId)).toContain(view.id);
    const [membership] = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ revision: number }>(
        await tx.execute(sql`SELECT revision::int AS revision FROM tenant_memberships
          WHERE tenant_id=${w.tenant.id} AND user_id=${source}::uuid`),
      ),
    );
    let removed: Promise<Response> = Promise.resolve(new Response());
    let instanceFree: boolean | undefined;
    await withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT tenant_id FROM org_settings WHERE tenant_id=${w.tenant.id} FOR UPDATE`);
      removed = w.request(w.hr.id, 'POST', `/api/tenant/permission/users/${source}/remove`, {
        ifMatch: membership!.revision,
      });
      await waitForBlocked(w.db, 1);
      instanceFree = await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT id FROM approval_instances WHERE tenant_id=${w.tenant.id}
          AND id=${view.id}::uuid FOR UPDATE NOWAIT`),
      ).then(
        () => true,
        (error: { code?: string; cause?: { code?: string } }) => {
          if ((error.code ?? error.cause?.code) !== '55P03') throw error;
          return false;
        },
      );
    });
    const response = await removed;
    expect(response.status, await response.clone().text()).toBe(200);
    expect(instanceFree, '等组织锁期间不应已持有实例锁').toBe(true);
  });
});

async function deadlocks(db: Db) {
  const [row] = (await db.execute(
    sql`SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname=current_database()`,
  )) as unknown as { n: number }[];
  return row!.n;
}
