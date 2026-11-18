/**
 * F-326-L AC-59 ②③④（S7e1）：交接重发不越序、不在中段锁变量，保存收尾推迟到提交前；锁台账自测。
 * ② 交接 × 审批的员工预锁（真 PG 强制交错，PGlite 跳过）：乙（异常管理员 U）审批通过 I1，在 openRun 之后、提交前暂停
 *    （已持主体员工 E 与 I1）；甲执行 U → U′ 交接，阻塞在 E 的员工行上且尚未重发；放行后两边都成功。
 *    “乙提交前取 X 不等待”要普通审批结束的登记挂点，随 S7e2 补齐。
 * ③ 交接 / 恢复重发推迟的保存收尾：Z 是被管理员手工重新启用过、已无任何引用的本流程自动变量，
 *    重发后由提交前的保存收尾 auto_disable；交接的操作者为交接操作人，restore 路径为空操作者；reason 都是“不再被引用”。
 * ④ 锁台账自测：SHARE 之后要 UPDATE、或 UPDATE {X} 之后要 {X, Y}，都是程序错误并整体回滚。
 */
import { randomUUID } from 'node:crypto';
import { restoreTenant } from '@italent/api';
import { exportTenantBackup, getUser, setUserStatus, sql, withTenant, type Db } from '@italent/db';
import { createTestDb, useTestDb } from '@italent/testkit';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type * as ApprovalContextModule from '../../apps/api/src/modules/approval/context.js';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { registerSaveClose } from '../../apps/api/src/modules/approval/auto-variable-lifecycle.js';
import { lockVariableBatch } from '../../apps/api/src/modules/approval/variables.js';
import type { InstanceView, NodeInput } from './AC-APV-support.js';
import { APPROVAL, references, variable, variableCommand, type S4World } from './AC-APV-F326-S4-support.js';
import {
  audits,
  autoAt,
  create,
  draftOk,
  manager,
  newVersion,
  publishWith,
  readProcess,
  s4World,
  specified,
  varRow,
} from './AC-APV-F326-S7a-support.js';
import { cmd } from './support/tenant-api.js';
import { idleInTransaction, lockWaiters, settledOrBlocked, withRelease } from './support/pg-interleave.js';

const hook = vi.hoisted(() => ({
  step: '',
  id: '',
  reached: Promise.resolve(),
  release: (): void => undefined,
  pause: async (): Promise<void> => undefined,
}));
// 暂停点只由 Vitest 包装已有跨模块函数注入：产品没有钩子状态或默认路径开销（复用 AC-42 的做法）
vi.mock('../../apps/api/src/modules/approval/context.js', async (original) => {
  const actual = await original<typeof ApprovalContextModule>();
  return {
    ...actual,
    auditApproval: async (...args: Parameters<typeof actual.auditApproval>) => {
      const entry = args[2];
      if (hook.step === 'persist' && entry.objectType === 'approval-instance' && entry.objectId === hook.id)
        await hook.pause();
      return actual.auditApproval(...args);
    },
  };
});
const database = useTestDb();
const handles: { close(): Promise<void> }[] = [];
afterAll(async () => {
  for (const handle of handles) await handle.close();
});
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
// 整库备份 / 恢复逐表进行，耗时随表数增长，单独放宽且仍有上限
const RESTORE_TIMEOUT = { timeout: 90_000 };

function arm(step: string, id: string) {
  let reached!: () => void;
  hook.step = step;
  hook.id = id;
  hook.reached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    hook.release = resolve;
  });
  hook.pause = async () => {
    hook.step = '';
    reached();
    await gate;
  };
}

const single = (key: string, userId: string): NodeInput => ({ key, name: `节点${key}`, approver: specified(userId) });
const viaManager = (key: string): NodeInput => ({ key, name: `节点${key}`, approver: manager });
const HRBP: NodeInput = { key: 'n2', name: '人力', approver: { type: 'department', value: 'record_department_hrbp' } };
const handoverRequest = (w: S4World, fromUserId: string, toUserId: string) =>
  w.request(w.hr.id, 'POST', `${APPROVAL}/exception-admins/handover`, { ifMatch: 0, body: { fromUserId, toUserId } });

async function waitingQuery(db: Db, expected: RegExp) {
  const rows = rowsOf<{ query: string; blockers: number }>(
    await db.execute(sql`SELECT query,cardinality(pg_blocking_pids(pid)) AS blockers FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.query).toMatch(expected);
  expect(rows[0]!.blockers).toBeGreaterThan(0);
}

/** 手工重新启用过、已无任何引用的本流程自动变量 Z：v1 的 n1 生成 Z，v2 不再引用，管理员停用后又重新启用。 */
async function reenabledUnreferenced(w: S4World) {
  const v1 = await w.publish(await create(w, [single('n1', w.near.userId)]));
  const z = await autoAt(w, v1.id, 'n1');
  const saved = await draftOk(w, await newVersion(w, v1), [viaManager('n1')]);
  const v2 = await w.json<typeof v1>(await publishWith(w, saved));
  const { total } = await references(w, 'variables', z.id);
  const off = await variableCommand(w, await varRow(w, z.id), 'disable', { acknowledgedReferenceCount: total });
  expect(off.status, await off.clone().text()).toBe(200);
  const on = await variableCommand(w, await varRow(w, z.id), 'enable');
  expect(on.status, await on.clone().text()).toBe(200);
  expect((await varRow(w, z.id)).status).toBe('enabled');
  return { process: v2, z };
}

const lastAudit = async (w: { db: Db; tenant: { id: string } }, id: string) => (await audits(w, id)).at(-1)!;

describe.runIf(realPostgres)('AC-APV-F326-59 ② 交接 × 审批的员工预锁（真 PG 强制交错，PGlite 跳过）', () => {
  it('乙（U）审批在 openRun 后暂停；甲交接阻塞在 E 的员工行上且未重发；放行后两边成功，I1 approved，X 仍启用', async () => {
    const w = await s4World(database().db, 's7e1-59-employee');
    const a = await w.publish(await create(w, [single('n1', w.head.userId), HRBP]));
    const x = await autoAt(w, a.id, 'n1');
    const first = await w.submit(await w.application(w.subject.employeeId, { departmentId: w.staff }));
    const passed = await w.json<InstanceView>(
      await w.taskAction(w.head.userId, w.pending(first)[0]!.id, 'approve', first.revision, {}),
    );
    expect(w.pending(passed).map((task) => [task.nodeKey, task.assigneeUserId])).toEqual([['n2', w.exceptionAdmin]]);
    const successor = await w.member('合成接任人');

    arm('persist', passed.id);
    await withRelease(
      () => hook.release(),
      async (lock) => {
        const approving = lock.track(
          w.taskAction(w.exceptionAdmin, w.pending(passed)[0]!.id, 'approve', passed.revision, {}),
        );
        await Promise.race([
          hook.reached,
          approving.then(() => {
            throw new Error('乙的暂停点未到达');
          }),
        ]);
        const handing = lock.track(handoverRequest(w, w.exceptionAdmin, successor));
        expect(await settledOrBlocked(w.db, handing, 1)).toBe('blocked');
        await waitingQuery(w.db, /employment_employees/i);
        // 甲还卡在员工预锁上：A 仍是 v1，没有 v1′
        const waiting = await readProcess(w, a.id);
        expect(waiting.currentVersion!.versionNo).toBe(1);
        expect(waiting.latestVersion.versionNo).toBe(1);

        hook.release();
        const done = await approving;
        expect(done.status, await done.clone().text()).toBe(200);
        const handed = await handing;
        expect(handed.status, await handed.clone().text()).toBe(200);
      },
    );

    const after = await readProcess(w, a.id);
    expect(after.currentVersion!.versionNo).toBe(2);
    expect(after.currentVersion!.exceptionAdminUserId).toBe(successor);
    const ended = await w.detail(passed.id);
    expect(ended.status).toBe('approved');
    expect(w.pending(ended)).toEqual([]);
    expect((await varRow(w, x.id)).status).toBe('enabled');
    expect(await lockWaiters(w.db)).toBe(0);
    expect(await idleInTransaction(w.db)).toBe(0);
  });
});

describe('AC-APV-F326-59 ③ 交接推迟的保存收尾', () => {
  it('交接重发 → Z 由提交前的保存收尾 auto_disable，操作者为交接操作人、reason“不再被引用”，事务不抛锁台账错误', async () => {
    const w = await s4World(database().db, 's7e1-59-handover-close');
    const { process, z } = await reenabledUnreferenced(w);
    const successor = await w.member('合成接任人');

    const handed = await handoverRequest(w, w.exceptionAdmin, successor);
    expect(handed.status, await handed.clone().text()).toBe(200);

    const after = await readProcess(w, process.id);
    expect(after.currentVersion!.versionNo).toBe(3);
    expect(after.currentVersion!.exceptionAdminUserId).toBe(successor);
    expect((await varRow(w, z.id)).status).toBe('disabled');
    const last = await lastAudit(w, z.id);
    expect(last.action).toBe('approval.public_variable.auto_disable');
    expect(last.actor).toBe(w.hr.id);
    expect(last.after).toMatchObject({ reason: '不再被引用' });
  });

  it('restore 路径（空操作者）重发 → 同样成功，Z 的操作者为空、reason“不再被引用”', RESTORE_TIMEOUT, async () => {
    const w = await s4World(database().db, 's7e1-59-restore-close');
    const { process, z } = await reenabledUnreferenced(w);
    const backup = await exportTenantBackup(w.db, { tenantId: w.tenant.id, codeVersion: 'approval' }, cmd());

    // 现网：交接给接任人并停用旧异常管理员，恢复对账才会改指现网异常管理员并重发
    const successor = await w.member('现网接任的异常管理员');
    const handed = await handoverRequest(w, w.exceptionAdmin, successor);
    expect(handed.status, await handed.clone().text()).toBe(200);
    const account = await getUser(w.db, w.exceptionAdmin);
    await setUserStatus(
      w.db,
      { userId: w.exceptionAdmin, status: 'disabled', expectedRevision: account!.revision },
      cmd(),
    );

    const handle = await createTestDb();
    handles.push(handle);
    const report = await restoreTenant(
      handle.db,
      { backup, live: w.db, attachments: { sha256: async () => null } },
      cmd(),
      w.clock,
    );
    expect(report.ok, JSON.stringify(report.reconciliation)).toBe(true);

    const restored = { db: handle.db, tenant: w.tenant };
    const admin = await withTenant(handle.db, w.tenant.id, async (tx) =>
      rowsOf<{ exception_admin_user_id: string }>(
        await tx.execute(sql`SELECT v.exception_admin_user_id::text FROM approval_processes p
          JOIN approval_process_versions v ON v.tenant_id=p.tenant_id AND v.id=p.current_version_id
          WHERE p.tenant_id=${w.tenant.id} AND p.id=${process.id}::uuid`),
      ),
    );
    expect(admin[0]!.exception_admin_user_id).toBe(successor);
    expect((await varRow(restored, z.id)).status).toBe('disabled');
    const last = await lastAudit(restored, z.id);
    expect(last.action).toBe('approval.public_variable.auto_disable');
    expect(last.actor).toBeNull();
    expect(last.after).toMatchObject({ reason: '不再被引用' });
  });
});

describe('AC-APV-F326-59 ④ 锁台账自测', () => {
  const context = (w: S4World) => ({
    tenantId: w.tenant.id,
    userId: w.hr.id,
    timezone: 'Asia/Shanghai',
    now: new Date(),
    commandId: randomUUID(),
    expectedRevision: 0,
  });

  it('对 X 取 FOR SHARE 后再登记需要 X 的收尾 → 提交时抛程序错误，整个事务回滚、无写入', async () => {
    const w = await s4World(database().db, 's7e1-59-ledger-share');
    const process = await w.publish(await create(w, [single('n1', w.near.userId)]));
    const x = await autoAt(w, process.id, 'n1');
    const ctx = context(w);

    await expect(
      withTenant(w.db, w.tenant.id, async (tx) => {
        await lockVariableBatch(tx, ctx, [{ id: x.id, mode: 'share' }]);
        await tx.execute(sql`UPDATE approval_variables SET name='回滚探针'
          WHERE tenant_id=${w.tenant.id}::uuid AND id=${x.id}::uuid`);
        registerSaveClose(tx, ctx, [x.id]);
      }),
    ).rejects.toThrow('自动变量锁台账');

    expect(await varRow(w, x.id)).toEqual(x);
  });

  it('先对 {X} 取 FOR UPDATE 再要 {X, Y} → 同样抛程序错误，整个事务回滚、无写入', async () => {
    const w = await s4World(database().db, 's7e1-59-ledger-subset');
    const process = await w.publish(await create(w, [single('n1', w.near.userId)]));
    const x = await autoAt(w, process.id, 'n1');
    const y = await variable(w);
    const ctx = context(w);

    await expect(
      withTenant(w.db, w.tenant.id, async (tx) => {
        await lockVariableBatch(tx, ctx, [{ id: x.id, mode: 'update' }]);
        await tx.execute(sql`UPDATE approval_variables SET name='回滚探针'
          WHERE tenant_id=${w.tenant.id}::uuid AND id=${x.id}::uuid`);
        await lockVariableBatch(tx, ctx, [
          { id: x.id, mode: 'update' },
          { id: y.id, mode: 'update' },
        ]);
      }),
    ).rejects.toThrow('自动变量锁台账');

    expect(await varRow(w, x.id)).toEqual(x);
  });
});
