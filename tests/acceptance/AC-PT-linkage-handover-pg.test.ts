/**
 * BE-7 PT-7 第 2 轮 P2-2（docs/08_设计/R2-T05_兼职设计.md §4.8 / §7.1）：新增申请带“新增下属”、末节点会签，异常管理员待办经
 * 批量交接 / 停用接管并入已占席位的审批人，合席当场落地——批量预锁必须在首次取员工锁之前把批内申请的下属一并规划（统一闭包，
 * UUID 升序），否则落地内补锁撞逆序保护，公开接口永久 409 TRANSFER_LOCK_PLAN_CHANGED（刷新重提仍然失败）。
 * 覆盖下属 UUID 小于 / 大于申请员工两种顺序 × 手动交接 / 全局停用接管；只在设了 TEST_DATABASE_URL 时运行。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { getUser, setUserStatus, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { findCurrentRecord } from '../../apps/api/src/modules/employment/read-model.js';
import { createPartTime } from '../../apps/api/src/modules/employment/part-time/service.js';
import { lockEmploymentEmployee } from '../../apps/api/src/modules/employment/record-store.js';
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';
import { pendingOf } from './support/f048.js';
import { orderedEmployeePair } from './support/ordered-employee-pair.js';
import { settledOrBlocked } from './support/pg-interleave.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

/** 两种员工 UUID 顺序都必须覆盖。 */
async function subordinateOrdered(w: RequestWorld, order: 'below' | 'above') {
  const pair = await orderedEmployeePair(
    w.worker,
    () => w.person(`下属${order}`, w.primary),
    (person) => person.employeeId,
    order,
  );
  expect(pair.subordinate.employeeId < pair.worker.employeeId).toBe(order === 'below');
  return pair;
}

const headOf = (w: RequestWorld) =>
  w.run(async (tx) => {
    const [row] = rowsOf<{ head: string | null }>(
      await tx.execute(sql`SELECT person_in_charge_id AS head FROM org_versions
        WHERE tenant_id=${w.tenant.id} AND org_id=${w.side}::uuid ORDER BY version_no DESC LIMIT 1`),
    );
    return row!.head;
  });
const managerOf = (w: RequestWorld, employeeId: string) =>
  w.run(async (tx) => (await findCurrentRecord(tx, w.tenant.id, employeeId, '2026-10-01'))!.fields.directManagerId);

/**
 * 场景：新增申请（带负责人 + 下属）前三个节点依次同意；末节点会签（兼职部门负责人为空 → 异常管理员占一席，兼职部门 HRBP 一席），
 * 兼职部门 HRBP 先同意自己的一席，剩异常管理员待办。之后把这张待办并给 HRBP（替代人已占席位 → 合席 → 本节点办结 → 落地）。
 */
async function scene(label: string, order: 'below' | 'above', external: boolean) {
  const w = await requestWorld(database().db, label, {
    lastCountersign: true,
    noSideHead: true,
    ...(external ? { externalExceptionAdmin: true } : {}),
  });
  // 场景夹具的 setOrgRoles 不动组织对象 revision；联动走真实组织写入（版本号 = revision + 1），把 revision 对齐已有版本
  await w.run((tx) =>
    tx.execute(sql`UPDATE org_objects SET revision=(SELECT max(version_no) FROM org_versions
      WHERE tenant_id=${w.tenant.id} AND org_id=${w.side}::uuid)
      WHERE tenant_id=${w.tenant.id} AND id=${w.side}::uuid`),
  );
  const { worker, subordinate: sub } = await subordinateOrdered(w, order);
  const created = await w.create({
    employeeId: worker.employeeId,
    isDepartmentHead: true,
    addedSubordinateIds: [sub.employeeId],
  });
  await w.send(created.id, created.revision);
  await w.approveInOrder(created.id, [w.approvers.pHrbp, w.approvers.pHead, w.approvers.sHrbp]);
  await w.decide(created.id, w.approvers.sHrbp, 'approve');
  const view = await w.instance(created.id);
  const source = external ? w.external!.id : w.exceptionAdmin;
  expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: source })]);
  return { w, worker, sub, created, view, source };
}

async function expectLanded(
  w: RequestWorld,
  worker: { employeeId: string },
  sub: { employeeId: string },
  requestId: string,
) {
  expect((await w.states(requestId)).map((event) => event.state)).toContain('effective');
  expect(await headOf(w)).toBe(worker.employeeId);
  expect(await managerOf(w, sub.employeeId)).toBe(worker.employeeId);
}

describe.runIf(realPostgres)('AC-PT-linkage-handover-pg 批量交接 / 停用接管 × 合席落地 × 申请下属预锁', () => {
  for (const order of ['below', 'above'] as const) {
    it(`手动交接（下属 UUID ${order === 'below' ? '小于' : '大于'}申请员工）：200，合席落地，负责人 / 下属经理已改`, async () => {
      const { w, worker, sub, created, source } = await scene(`lk-handover-${order}`, order, false);
      const admin = await w.member('交接操作员');
      await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: admin }, cmd());
      const response = await w.request(admin, 'POST', '/api/tenant/approval/exception-admins/handover', {
        ifMatch: 0,
        body: { fromUserId: source, toUserId: w.approvers.sHrbp.userId },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      await expectLanded(w, worker, sub, created.id);
    });

    it(`全局停用接管（下属 UUID ${order === 'below' ? '小于' : '大于'}申请员工）：停用成功，合席落地，负责人 / 下属经理已改`, async () => {
      const { w, worker, sub, created, source } = await scene(`lk-takeover-${order}`, order, true);
      // DEC-098：仍是可用流程的异常管理员时拒绝停用——作废流程，在途实例按冻结版本继续；替代人由可信夹具直写（已占席位的 HRBP）
      const processes = await w.json<{ items: { id: string; revision: number }[] }>(
        await w.request(w.hr.id, 'GET', '/api/tenant/approval/processes?approvalType=part_time_add'),
      );
      const process = processes.items[0]!;
      await w.json(
        await w.request(w.hr.id, 'POST', `/api/tenant/approval/processes/${process.id}/discard`, {
          ifMatch: process.revision,
        }),
      );
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`INSERT INTO approval_exception_admin_successors
          (tenant_id,user_id,successor_user_id,designated_by,command_id)
          VALUES (${w.tenant.id},${source}::uuid,${w.approvers.sHrbp.userId}::uuid,${w.hr.id}::uuid,${randomUUID()})`),
      );
      const user = await getUser(w.db, source);
      await setUserStatus(w.db, { userId: source, status: 'disabled', expectedRevision: user!.revision }, cmd());
      await expectLanded(w, worker, sub, created.id);
    });
  }
});

/**
 * 第 3 轮 P2：只设负责人、不带新增下属的新增申请，审批落地也要在第一次员工锁之前收齐闭包——A 另有未来兼职的待执行下属 B 时，
 * 落地办完整意图（含 B），若 adapter 的预锁只锁 A、落地才补锁 B，会与“先锁 B 再取组织锁”的另一事务成环（40P01 → 409
 * APPROVAL_CONCURRENT_CONFLICT）。adapter 对新增申请一律走闭包规划（审批编辑当次才打开负责人的情形同样覆盖）。
 */
describe.runIf(realPostgres)('AC-PT-linkage-handover-pg 第 3 轮：只设负责人的申请审批 × 先锁下属的另一事务', () => {
  async function headOnly(label: string, openByApprovalEdit: boolean) {
    const w = await requestWorld(database().db, label);
    await w.run((tx) =>
      tx.execute(sql`UPDATE org_objects SET revision=(SELECT max(version_no) FROM org_versions
        WHERE tenant_id=${w.tenant.id} AND org_id=${w.side}::uuid)
        WHERE tenant_id=${w.tenant.id} AND id=${w.side}::uuid`),
    );
    const sub = await w.person('合成待执行下属', w.primary);
    const pendingOrg = await w.org('合成未来兼职部门');
    await w.run((tx) =>
      createPartTime(tx, w.context(), {
        employeeId: w.worker.employeeId,
        serviceType: 'part_time',
        startDate: '2026-10-20',
        departmentId: pendingOrg,
        addedSubordinateIds: [sub.employeeId],
      }),
    );
    const created = await w.create(openByApprovalEdit ? {} : { isDepartmentHead: true });
    await w.send(created.id, created.revision);
    await w.approveInOrder(created.id, w.order.add.slice(0, 3));
    const view = await w.instance(created.id);
    const task = w.pending(view)[0]!;
    const held = signal();
    const release = signal();
    const other = withTenant(w.db, w.tenant.id, async (tx) => {
      await lockEmploymentEmployee(tx, w.context(), sub.employeeId);
      held.resolve();
      await release.promise;
      await lockOrganizationSettings(tx, w.tenant.id);
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await held.promise;
    const approval = w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
      comment: '合成审批',
      ...(openByApprovalEdit ? { fields: { isDepartmentHead: true } } : {}),
    });
    expect(await settledOrBlocked(w.db, approval, 1)).toBe('blocked');
    release.resolve();
    const otherResult = await other;
    const response = await approval;
    expect(otherResult, '另一事务不得被死锁牺牲').toBeUndefined();
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await w.load(created.id)).state).toBe('effective');
    expect(await headOf(w)).toBe(w.worker.employeeId);
  }

  it('申请本身只设负责人：末节点同意在第一次员工锁前收齐 A 的待执行下属闭包，不死锁', () =>
    headOnly('lk-head-only', false));

  it('申请无联动、末节点审批编辑当次才打开负责人：同样先收齐闭包，不死锁', () => headOnly('lk-edit-opens-head', true));
});
