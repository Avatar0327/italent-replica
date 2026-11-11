/**
 * AC-F476-10（P6 部分，真 PostgreSQL，普通角色）：Offer 单 / Offer 批的办理与并发写交错，只得完整 A 或完整 B / 409。
 * 屏障制造稳定交错：测试会话先持业务行锁（Offer 行 / 实例行），两个请求都排到锁后（waitForBlocked 数到等锁会话）才放行，
 * 先后交给数据库，不靠 Promise.all 偶然重现。断言只核对不变量：办理份数 = 办理成功数；份内容（快照与扩展）同属办理那一刻；
 * 办理失败时不留半份。PGlite 单连接无法并发，本文件仅在设了 TEST_DATABASE_URL 时运行。
 * 覆盖：编辑 × 同意（单 Offer）、子项改动 × 集合办理（批）、接管 × 同意、成员停用 × 同意、
 * 两次读名称之间部门改名 × 同意（评审 P2-2：份里的标签与引用名须同一时刻）。
 */
import { revokeMembership, sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { offerApprovalWorld } from './AC-OF-BE14a3-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import {
  APPROVAL,
  NAME_A1,
  NAME_A2,
  NAME_B1,
  PLACE_A,
  PLACE_B,
  copiesFor,
  createOffer,
  handledBatch,
  pendingTask,
  renameOrg,
  type World,
} from './AC-F476-p6-support.js';
import { cmd } from './support/tenant-api.js';
import { waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const OK_OR_CONFLICT = [200, 403, 409];

/** 持某行锁当屏障：fire 里发出的请求都排在它后面，数到 expected 个等锁会话后放行。 */
async function raced(
  w: World,
  lockSql: (tenantId: string) => ReturnType<typeof sql>,
  fire: () => Promise<unknown>[],
  blocked = 2,
) {
  let pending: Promise<unknown>[] = [];
  await withTenant(w.db, w.tenant.id, async (barrier) => {
    await barrier.execute(lockSql(w.tenant.id));
    pending = fire();
    await waitForBlocked(w.db, blocked);
  });
  return Promise.all(pending);
}
const lockOffer = (id: string) => (tenantId: string) =>
  sql`SELECT id FROM offers WHERE tenant_id = ${tenantId} AND id = ${id}::uuid FOR UPDATE`;
const lockInstance = (id: string) => (tenantId: string) =>
  sql`SELECT id FROM approval_instances WHERE tenant_id = ${tenantId} AND id = ${id}::uuid FOR UPDATE`;

/** 绕过审批的子项改动（可信夹具直写，等价于 BE-14a2 转移状态等旁路）：升 revision、改地点。 */
const bypassEdit = (w: World, offerId: string) =>
  withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.execute(sql`UPDATE offers SET work_place = ${PLACE_B}, name = ${NAME_B1}, revision = revision + 1
      WHERE tenant_id = ${w.tenant.id} AND id = ${offerId}::uuid`);
    return { status: 200 };
  });

const action = (w: World, taskId: string, userId: string, revision: number, verb: string) =>
  w.request(userId, 'POST', `${APPROVAL}/tasks/${taskId}/${verb}`, {
    ifMatch: revision,
    body: { comment: '合成意见' },
  });

/**
 * 名称屏障：包一层 db，办理事务里第一次读到 marker（办理时部门名）的原生查询返回后，另一个连接提交部门改名再放行。
 * 原生查询之后若还有语句另读名称，就会读到改名后的值——份里标签与引用名不一致即失败（设计 §4.3 单条一致性查询）。
 */
function nameBarrier(raw: Db) {
  const hook = { marker: '', onHit: async () => {}, hits: 0 };
  type Exec = (...args: unknown[]) => Promise<unknown>;
  type Begin = (cb: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => Promise<unknown>;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, prop, receiver) {
        const value = Reflect.get(object, prop, receiver) as unknown;
        if (prop === 'execute')
          return async (...args: unknown[]) => {
            const result = await (value as Exec).apply(object, args);
            if (hook.marker && JSON.stringify(resultRows(result)).includes(hook.marker)) {
              hook.marker = '';
              hook.hits += 1;
              await hook.onHit();
            }
            return result;
          };
        if (prop === 'transaction')
          return (cb: (tx: object) => Promise<unknown>, ...rest: unknown[]) =>
            (value as Begin).call(object, (tx) => cb(wrap(tx as object)), ...rest);
        return value;
      },
    });
  return { db: wrap(raw), hook };
}

describe.runIf(realPostgres)('AC-F476-10 P6：Offer 单 / 批办理与并发写交错', () => {
  it('单 Offer：HTTP 编辑 × 同意——编辑一律 409（审批中不可编辑），办理份是办理时的 A', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-10-edit-approve');
    const offer = await createOffer(w, NAME_A1);
    await w.json(await w.submitRaw(offer));
    const view = await w.instance(offer.id);
    const task = await pendingTask(w, view, w.head);
    const dept = (await w.get(offer.id)).departmentName as string;
    const edit = () =>
      w.request(w.applicant.userId, 'PUT', `/api/tenant/offers/${offer.id}`, {
        ifMatch: view.revision,
        body: { workPlace: PLACE_B },
      });
    const [edited, approved] = (await raced(w, lockOffer(offer.id), () => [
      edit(),
      action(w, task.id, w.head.userId, view.revision, 'approve'),
    ])) as Response[];
    expect(edited!.status).toBe(409);
    expect(approved!.status, await approved!.clone().text()).toBe(200);
    const copies = await copiesFor(w, view.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.text).toContain(PLACE_A);
    expect(copies[0]!.text).not.toContain(PLACE_B);
    expect(copies[0]!.text, '办理份须带办理时的名称标签').toContain(dept);
  });

  it('单 Offer：旁路改动 × 同意——同意成功则份内容是 A；改动先到则同意 409、不留份', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-10-bypass-approve');
    const offer = await createOffer(w, NAME_A1);
    await w.json(await w.submitRaw(offer));
    const view = await w.instance(offer.id);
    const task = await pendingTask(w, view, w.head);
    const dept = (await w.get(offer.id)).departmentName as string;
    const [approved] = (await raced(w, lockOffer(offer.id), () => [
      action(w, task.id, w.head.userId, view.revision, 'approve'),
      bypassEdit(w, offer.id),
    ])) as [Response, unknown];
    expect(OK_OR_CONFLICT).toContain(approved.status);
    const copies = await copiesFor(w, view.id);
    expect(copies).toHaveLength(approved.status === 200 ? 1 : 0);
    if (copies[0]) {
      expect(copies[0].text).toContain(PLACE_A);
      expect(copies[0].text).not.toContain(PLACE_B);
      expect(copies[0].text).not.toContain(NAME_B1);
      expect(copies[0].text, '办理份须带办理时的名称标签').toContain(dept);
    }
  });

  it('批：子项旁路改动 × 集合办理——办理份的快照行与扩展行同属一个状态（全 A 或无份 / 409）', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-10-batch-child');
    const a = await createOffer(w, NAME_A1);
    const b = await createOffer(w, NAME_A2);
    const batch = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [a.id, b.id] }), 201);
    const view = await w.instance(batch.id);
    const task = await pendingTask(w, view, w.manager);
    const dept = (await w.get(a.id)).departmentName as string;
    const [handled] = (await raced(w, lockOffer(b.id), () => [
      action(w, task.id, w.manager.userId, view.revision, 'approve'),
      bypassEdit(w, b.id),
    ])) as [Response, unknown];
    expect(OK_OR_CONFLICT).toContain(handled.status);
    const copies = await copiesFor(w, view.id);
    expect(copies).toHaveLength(handled.status === 200 ? 1 : 0);
    if (copies[0]) {
      expect(copies[0].text).toContain(NAME_A1);
      expect(copies[0].text).toContain(NAME_A2);
      expect(copies[0].text).not.toContain(NAME_B1);
      expect(copies[0].text, '办理份须带行内办理时的名称标签').toContain(dept);
    }
  });

  it('批：成员 Offer 被另一张批单同时拉走 × 集合办理——要么办理成功，要么 409，不出现半份', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-10-batch-steal');
    const s = await handledBatch(w); // 先办完一张批，a / b 回到可重新发起
    const extra = await createOffer(w, 'ZZ_第二批成员');
    const first = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [extra.id] }), 201);
    const view = await w.instance(first.id);
    const task = await pendingTask(w, view, w.manager);
    const second = () => w.batchRaw({ offerIds: [s.a.id, extra.id] });
    const [handled, other] = (await raced(w, lockOffer(extra.id), () => [
      action(w, task.id, w.manager.userId, view.revision, 'approve'),
      second(),
    ])) as [Response, Response];
    expect(OK_OR_CONFLICT).toContain(handled.status);
    expect([201, 409]).toContain(other.status);
    const copies = await copiesFor(w, view.id);
    expect(copies).toHaveLength(handled.status === 200 ? 1 : 0);
  });

  it('接管 × 同意：二者不同时成功；同意成功则有一份，接管成功则原人没有份', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-10-takeover');
    const offer = await createOffer(w, NAME_A1);
    await w.json(await w.submitRaw(offer));
    const view = await w.instance(offer.id);
    const task = await pendingTask(w, view, w.head);
    const taker = await w.person('接管人', w.department);
    const takeover = () =>
      w.request(w.hr.id, 'POST', `${APPROVAL}/instances/${view.id}/admin-transfer`, {
        ifMatch: view.revision,
        body: { taskId: task.id, toUserId: taker.userId, reason: '合成原因' },
      });
    const [approved, moved] = (await raced(w, lockInstance(view.id), () => [
      action(w, task.id, w.head.userId, view.revision, 'approve'),
      takeover(),
    ])) as Response[];
    expect([approved!.status, moved!.status].filter((s) => s === 200)).toHaveLength(1);
    const copies = await copiesFor(w, view.id);
    expect(copies).toHaveLength(approved!.status === 200 ? 1 : 0);
    if (moved!.status === 200) expect(copies.filter((c) => c.actor_user_id === w.head.userId)).toHaveLength(0);
  });

  it('成员停用 × 同意：办理份数 = 同意成功数，停用不留下半份', async () => {
    const w = await offerApprovalWorld(testDb().db, 'p6-10-deactivate');
    const offer = await createOffer(w, NAME_A1);
    await w.json(await w.submitRaw(offer));
    const view = await w.instance(offer.id);
    const task = await pendingTask(w, view, w.head);
    const deactivate = async () => {
      const [row] = await withTenant(w.db, w.tenant.id, async (tx) =>
        resultRows<{ revision: number }>(
          await tx.execute(sql`SELECT revision FROM tenant_memberships WHERE tenant_id = ${w.tenant.id}
            AND user_id = ${w.head.userId}::uuid`),
        ),
      );
      try {
        await revokeMembership(
          w.db,
          {
            tenantId: w.tenant.id,
            userId: w.head.userId,
            expectedRevision: Number(row!.revision),
          },
          cmd(),
        );
        return { status: 200 };
      } catch {
        return { status: 409 };
      }
    };
    // 先让同意排到实例行锁后（已通过成员校验），再发停用（停用要改这个人名下的在办任务，同样排队），两者都排上才放锁
    let pending: [Promise<Response>, Promise<unknown>] | undefined;
    await withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(lockInstance(view.id)(w.tenant.id));
      const approve = action(w, task.id, w.head.userId, view.revision, 'approve');
      await waitForBlocked(w.db, 1);
      pending = [approve, deactivate()];
      await waitForBlocked(w.db, 2);
    });
    const [approved] = await Promise.all(pending!);
    expect([200, 401, 403, 409]).toContain(approved.status);
    const copies = await copiesFor(w, view.id);
    expect(copies).toHaveLength(approved.status === 200 ? 1 : 0);
  });

  it('两次读名称之间部门改名 × 同意：份里的部门标签与引用名同属一个时刻（全 A 或全 B），或 409', async () => {
    const raw = testDb().db;
    const { db, hook } = nameBarrier(raw);
    const w = await offerApprovalWorld(db, 'p6-10-rename-between');
    const offer = await createOffer(w, NAME_A1);
    await w.json(await w.submitRaw(offer));
    const view = await w.instance(offer.id);
    const task = await pendingTask(w, view, w.head);
    const current = await w.get(offer.id);
    const nameA = current.departmentName as string;
    const nameB = 'ZZ_屏障间改名的部门';
    hook.marker = nameA;
    hook.onHit = () => renameOrg({ ...w, db: raw }, current.departmentId as string, nameB);
    const approved = await action(w, task.id, w.head.userId, view.revision, 'approve');
    expect(hook.hits, '夹具：办理事务里读到了办理时的部门名').toBe(1);
    expect([200, 409]).toContain(approved.status);
    const copies = await copiesFor({ ...w, db: raw }, view.id);
    expect(copies).toHaveLength(approved.status === 200 ? 1 : 0);
    if (!copies[0]) return;
    const { ext } = JSON.parse(copies[0].text) as {
      ext: { labels: Record<string, string | null>; refs: Record<string, string | null> };
    };
    expect([nameA, nameB]).toContain(ext.labels.departmentName);
    expect(ext.refs.departmentIdName, '标签与引用名须同一时刻').toBe(ext.labels.departmentName);
  });
});
