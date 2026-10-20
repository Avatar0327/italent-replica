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
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';
import { pendingOf } from './support/f048.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

/** 造一个 UUID 比申请员工小 / 大的下属（随机 UUID，按需重试，两种顺序都必须覆盖）。 */
async function subordinateOrdered(w: RequestWorld, order: 'below' | 'above') {
  for (let attempt = 0; attempt < 24; attempt++) {
    const person = await w.person(`下属${order}${attempt}`, w.primary);
    if ((order === 'below') === person.employeeId < w.worker.employeeId) return person;
  }
  throw new Error('造不出指定 UUID 顺序的下属');
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
  const sub = await subordinateOrdered(w, order);
  const created = await w.create({ isDepartmentHead: true, addedSubordinateIds: [sub.employeeId] });
  await w.send(created.id, created.revision);
  await w.approveInOrder(created.id, [w.approvers.pHrbp, w.approvers.pHead, w.approvers.sHrbp]);
  await w.decide(created.id, w.approvers.sHrbp, 'approve');
  const view = await w.instance(created.id);
  const source = external ? w.external!.id : w.exceptionAdmin;
  expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: source })]);
  return { w, sub, created, view, source };
}

async function expectLanded(w: RequestWorld, sub: { employeeId: string }, requestId: string) {
  expect((await w.states(requestId)).map((event) => event.state)).toContain('effective');
  expect(await headOf(w)).toBe(w.worker.employeeId);
  expect(await managerOf(w, sub.employeeId)).toBe(w.worker.employeeId);
}

describe.runIf(realPostgres)('AC-PT-linkage-handover-pg 批量交接 / 停用接管 × 合席落地 × 申请下属预锁', () => {
  for (const order of ['below', 'above'] as const) {
    it(`手动交接（下属 UUID ${order === 'below' ? '小于' : '大于'}申请员工）：200，合席落地，负责人 / 下属经理已改`, async () => {
      const { w, sub, created, source } = await scene(`lk-handover-${order}`, order, false);
      const admin = await w.member('交接操作员');
      await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: admin }, cmd());
      const response = await w.request(admin, 'POST', '/api/tenant/approval/exception-admins/handover', {
        ifMatch: 0,
        body: { fromUserId: source, toUserId: w.approvers.sHrbp.userId },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      await expectLanded(w, sub, created.id);
    });

    it(`全局停用接管（下属 UUID ${order === 'below' ? '小于' : '大于'}申请员工）：停用成功，合席落地，负责人 / 下属经理已改`, async () => {
      const { w, sub, created, source } = await scene(`lk-takeover-${order}`, order, true);
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
      await expectLanded(w, sub, created.id);
    });
  }
});
