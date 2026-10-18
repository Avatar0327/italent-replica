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
import {
  createUser,
  getUser,
  grantMembership,
  setUserStatus,
  sql,
  withPlatform,
  withTenant,
  type Db,
} from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
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
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as any).cause?.code;
    if (code === '55P03') return 'held';
    throw error;
  }
}
const TENANT = { value: '' };

/** 外部异常管理员 U 名下有一张兼职新增申请的异常待办（主职 HRBP 为空，首节点转异常管理员，F-165③）。 */
async function scene(label: string) {
  const db = database().db;
  const source = await createUser(db, { email: `${label}-${randomUUID()}@example.com`, displayName: '外部异常管理员' }, cmd());
  const w = await requestWorld(db, label, { noPrimaryHrbp: true, exceptionAdmin: source.id });
  TENANT.value = w.tenant.id;
  await grantMembership(db, { tenantId: w.tenant.id, userId: source.id, expectedRevision: 0 }, cmd());
  const created = await w.create({ endDate: '2026-12-31' });
  await w.submit(created.id, 1);
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
      expect(await probe(db, sql`SELECT id FROM users WHERE id=${source.id}::uuid FOR NO KEY UPDATE NOWAIT`, true)).toBe(
        'free',
      );
    });
    expect(await disabled, '停用接管不得被映射成并发冲突（40P01）').toBe('ok');
    expect(pendingOf(await w.detail(view.id))).toEqual([expect.objectContaining({ assigneeUserId: successor })]);
  });

  it('单个同意（lock）：B 持组织锁时 A 在适配器 lock 的组织锁上等待，早于锁实例；放行后同意完成、状态推进', async () => {
    const w = await requestWorld(database().db, 'pt-lock-single');
    TENANT.value = w.tenant.id;
    const created = await w.create({ endDate: '2026-12-31' });
    await w.submit(created.id, 1);
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
