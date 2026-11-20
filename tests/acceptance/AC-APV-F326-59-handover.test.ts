/**
 * F-326-L AC-59 ②③④（S7e1）：交接重发不越序、不在中段锁变量，保存收尾推迟到提交前；锁台账自测。
 * ② 交接 × 审批的员工预锁（真 PG 强制交错，PGlite 跳过；审查 P2-2）：个人信息变更（personnel_change）实例 I1，
 *    乙（异常管理员 U）审批通过 I1，经适配器 lockPerson 持主体员工 E，在 openRun 之后、提交前暂停；
 *    甲执行 U → U′ 交接，阻塞在 E 的员工行上，阻塞者是乙的会话（pg_blocking_pids），且测试侧记录的重发调用为空——
 *    “先预锁员工、再重发”由重发调用边界证明，不靠另一条连接读到的已提交版本；放行后两边都成功、各重发一次。
 *    “乙提交前取 X 不等待”要普通审批结束的登记挂点，随 S7e2 补齐。
 * ③ 交接 / 恢复重发推迟的保存收尾（审查 P2-3）：Z 是被管理员手工重新启用过、已无任何引用的本流程自动变量。
 *    交接使 I2（会签合席）在同一事务内结束：测试在该事务内读取——重发返回时、I2 持久化时 Z 仍启用；提交后 Z 停用，
 *    只多一条 auto_disable；交接的操作者为交接操作人，restore 路径为空操作者；reason 都是“不再被引用”。
 * ④ 锁台账自测：SHARE 之后要 UPDATE、或 UPDATE {X} 之后要 {X, Y}，都是程序错误并整体回滚；
 *    只登记查询实际返回的变量，来源不存在时保留原业务错误（审查 P3）。
 */
import { randomUUID } from 'node:crypto';
import { restoreTenant } from '@italent/api';
import {
  exportTenantBackup,
  getUser,
  setUserStatus,
  sql,
  transactionLockLedger,
  withTenant,
  type Db,
  type Tx,
} from '@italent/db';
import { createTestDb, useTestDb } from '@italent/testkit';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type * as ApprovalContextModule from '../../apps/api/src/modules/approval/context.js';
import type * as ApprovalDefinitionsModule from '../../apps/api/src/modules/approval/definitions.js';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { registerSaveClose } from '../../apps/api/src/modules/approval/auto-variable-lifecycle.js';
import { loadVariable, lockVariableBatch } from '../../apps/api/src/modules/approval/variables.js';
import type { InstanceView, NodeInput } from './AC-APV-support.js';
import {
  APPROVAL,
  counter,
  personnelChange,
  references,
  variable,
  variableCommand,
  type S4World,
} from './AC-APV-F326-S4-support.js';
import {
  actionsOf,
  audits,
  autoAt,
  create,
  draftOk,
  manager,
  newVersion,
  publicVar,
  publishWith,
  readProcess,
  s4World,
  specified,
  varRow,
} from './AC-APV-F326-S7a-support.js';
import { cmd } from './support/tenant-api.js';
import {
  idleInTransaction,
  lockWaiters,
  settledOrBlocked,
  withHeldLock,
  withRelease,
} from './support/pg-interleave.js';

const hook = vi.hoisted(() => ({
  step: '',
  id: '',
  reached: Promise.resolve(),
  release: (): void => undefined,
  pause: async (_tx: unknown): Promise<void> => undefined,
  approverPid: 0,
  lockedIds: [] as string[],
  /** 测试侧记录：交接对 republishWithExceptionAdmin 的每次调用（流程 ID），用来证明重发的调用边界。 */
  republished: [] as string[],
  /** 事务内观察点（读 Z / 实例状态，用的是交接事务自己的 tx）；未设置时为空操作。 */
  observe: async (_at: string, _tx: unknown): Promise<void> => undefined,
  watchInstance: '',
}));
// 暂停点只由 Vitest 包装已有跨模块函数注入：产品没有钩子状态或默认路径开销（复用 AC-42 的做法）
vi.mock('../../apps/api/src/modules/approval/context.js', async (original) => {
  const actual = await original<typeof ApprovalContextModule>();
  return {
    ...actual,
    auditApproval: async (...args: Parameters<typeof actual.auditApproval>) => {
      const entry = args[2];
      if (hook.step === 'persist' && entry.objectType === 'approval-instance' && entry.objectId === hook.id)
        await hook.pause(args[0]);
      if (hook.watchInstance && entry.objectType === 'approval-instance' && entry.objectId === hook.watchInstance)
        await hook.observe('instance-persist', args[0]);
      return actual.auditApproval(...args);
    },
  };
});
// 重发的调用边界与返回时刻：Vitest 包装跨模块导出（handover.ts 自 definitions.js 导入），产品代码不留钩子
vi.mock('../../apps/api/src/modules/approval/definitions.js', async (original) => {
  const actual = await original<typeof ApprovalDefinitionsModule>();
  return {
    ...actual,
    republishWithExceptionAdmin: async (...args: Parameters<typeof actual.republishWithExceptionAdmin>) => {
      hook.republished.push(args[2]);
      const result = await actual.republishWithExceptionAdmin(...args);
      await hook.observe('republish-returned', args[0]);
      return result;
    },
  };
});
vi.mock('../../apps/api/src/modules/approval/variables.js', async (original) => {
  const actual = await original<typeof import('../../apps/api/src/modules/approval/variables.js')>();
  return {
    ...actual,
    lockVariableBatch: async (...args: Parameters<typeof actual.lockVariableBatch>) => {
      await actual.lockVariableBatch(...args);
      if (!hook.watchInstance) return;
      const [row] = rowsOf<{ pid: number }>(await args[0].execute(sql`SELECT pg_backend_pid()::int AS pid`));
      if (row?.pid === hook.approverPid) {
        const ledger = transactionLockLedger(args[0]);
        hook.lockedIds.push(...args[2].filter(({ id }) => ledger.held(id) === 'update').map(({ id }) => id));
      }
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
  hook.pause = async (tx) => {
    hook.step = '';
    // 记下暂停者（审批会话）的后端进程号，交接的阻塞者要核对到它
    const [row] = rowsOf<{ pid: number }>(await (tx as Tx).execute(sql`SELECT pg_backend_pid()::int AS pid`));
    hook.approverPid = row!.pid;
    reached();
    await gate;
  };
}

const single = (key: string, userId: string): NodeInput => ({ key, name: `节点${key}`, approver: specified(userId) });
const viaManager = (key: string): NodeInput => ({ key, name: `节点${key}`, approver: manager });
const HRBP: NodeInput = { key: 'n2', name: '人力', approver: { type: 'department', value: 'record_department_hrbp' } };
const handoverRequest = (w: S4World, fromUserId: string, toUserId: string) =>
  w.request(w.hr.id, 'POST', `${APPROVAL}/exception-admins/handover`, { ifMatch: 0, body: { fromUserId, toUserId } });

/** 唯一在等锁的会话：其语句与阻塞它的后端进程号（pg_blocking_pids）。 */
async function waitingSession(db: Db) {
  const rows = rowsOf<{ query: string; blockers: string }>(
    await db.execute(sql`SELECT query, array_to_string(pg_blocking_pids(pid), ',') AS blockers FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
  );
  expect(rows).toHaveLength(1);
  return {
    query: rows[0]!.query,
    blockers: rows[0]!.blockers.split(',').filter(Boolean).map(Number),
  };
}

/** 手工重新启用过、已无任何引用的本流程自动变量 Z：v1 的 n1 生成 Z，v2 不再引用，管理员停用后又重新启用。 */
async function reenabledUnreferenced(w: S4World) {
  const v1 = await w.publish(await create(w, [single('n1', w.near.userId)]));
  const z = await autoAt(w, v1.id, 'n1');
  const saved = await draftOk(w, await newVersion(w, v1), [viaManager('n1')]);
  const { total } = await references(w, 'variables', z.id);
  const off = await variableCommand(w, await varRow(w, z.id), 'disable', { acknowledgedReferenceCount: total });
  expect(off.status, await off.clone().text()).toBe(200);
  const v2 = await w.json<typeof v1>(await publishWith(w, saved));
  const on = await variableCommand(w, await varRow(w, z.id), 'enable');
  expect(on.status, await on.clone().text()).toBe(200);
  expect((await varRow(w, z.id)).status).toBe('enabled');
  return { process: v2, z };
}

/**
 * Z 同上（v1 的 n1 生成，v2 不再引用，管理员停用后重新启用）；v2 是 [c0 指定 near → c1 会签：指定 head + 本部门 HRBP（空，转异常管理员；首节点不能有空席，故会签放第二个）]，
 * 个人信息变更实例 I2 绑定 v2：head 已同意自己的席位，剩异常管理员 U 的待办。交接给 head 时 U 的席位并入 head 已同意的席位，I2 办结。
 */
async function reenabledWithCountersign(w: S4World, olderInstance = false) {
  const v1 = await w.publish(await create(w, [single('n1', w.near.userId)], { approvalType: 'personnel_change' }));
  const z = await autoAt(w, v1.id, 'n1');
  const joint = counter([specified(w.head.userId), HRBP.approver!], { key: 'c1', name: '联合会签' });
  const saved = await draftOk(w, await newVersion(w, v1), [single('c0', w.near.userId), joint]);
  const { total } = await references(w, 'variables', z.id);
  const off = await variableCommand(w, await varRow(w, z.id), 'disable', { acknowledgedReferenceCount: total });
  expect(off.status, await off.clone().text()).toBe(200);
  const v2 = await w.json<typeof v1>(await publishWith(w, saved));
  const { instance: first } = await (await personnelChange(w)).submit();
  const instance = await w.json<InstanceView>(
    await w.taskAction(w.near.userId, w.pending(first)[0]!.id, 'approve', first.revision, {}),
  );
  const seat = w.pending(instance).find((task) => task.assigneeUserId === w.head.userId)!;
  const passed = await w.json<InstanceView>(
    await w.taskAction(w.head.userId, seat.id, 'approve', instance.revision, {}),
  );
  expect(w.pending(passed).map((task) => task.assigneeUserId)).toEqual([w.exceptionAdmin]);
  const x = await autoAt(w, v2.id, 'c1');
  let process = v2;
  if (olderInstance) {
    // X 留在 v2 和另一流程草稿，确保重发的保存收尾候选不含 X，等待只能来自 I2 的生命周期登记。
    await create(w, [{ key: 'only', approver: publicVar(x.id) }]);
    process = await w.publish(await draftOk(w, await newVersion(w, v2), [viaManager('replacement')]));
  }
  const on = await variableCommand(w, await varRow(w, z.id), 'enable');
  expect(on.status, await on.clone().text()).toBe(200);
  expect((await varRow(w, z.id)).status).toBe('enabled');
  return { process, z, x, instance: passed };
}

const lastAudit = async (w: { db: Db; tenant: { id: string } }, id: string) => (await audits(w, id)).at(-1)!;

/** 个人信息变更流程 [n1 指定人 → n2 本部门 HRBP（空，转异常管理员）]；n1 通过后 n2 待办在异常管理员名下。 */
async function personnelAtException(w: S4World) {
  const process = await w.publish(
    await create(w, [single('n1', w.head.userId), HRBP], { approvalType: 'personnel_change' }),
  );
  const { instance } = await (await personnelChange(w)).submit();
  const passed = await w.json<InstanceView>(
    await w.taskAction(w.head.userId, w.pending(instance)[0]!.id, 'approve', instance.revision, {}),
  );
  expect(w.pending(passed).map((task) => [task.nodeKey, task.assigneeUserId])).toEqual([['n2', w.exceptionAdmin]]);
  return { process, passed };
}

describe.runIf(realPostgres)('AC-APV-F326-59 ② 交接 × 审批的员工预锁（真 PG 强制交错，PGlite 跳过）', () => {
  it('乙（U）审批个人信息变更在 openRun 后暂停；甲交接被乙的会话阻塞在员工行上且未重发；放行后两边成功、各重发一次', async () => {
    const w = await s4World(database().db, 's7e1-59-employee');
    const { process: a, passed } = await personnelAtException(w);
    const x = await autoAt(w, a.id, 'n1');
    const successor = await w.member('合成接任人');
    hook.republished = [];

    hook.lockedIds = [];
    hook.watchInstance = passed.id;
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
        expect(hook.approverPid).toBeGreaterThan(0);
        const handing = lock.track(handoverRequest(w, w.exceptionAdmin, successor));
        expect(await settledOrBlocked(w.db, handing, 1)).toBe('blocked');
        const waiter = await waitingSession(w.db);
        // 等的是员工行，且阻塞者就是持有员工锁（经适配器 lockPerson）的审批会话
        expect(waiter.query).toMatch(/employment_employees/i);
        expect(waiter.blockers).toContain(hook.approverPid);
        // 交接尚未调用重发：先预锁员工、再重发，由测试侧记录的调用边界证明（另一连接只能读到已提交的 v1，证明不了）
        expect(hook.republished).toEqual([]);

        hook.release();
        const done = await approving;
        expect(done.status, await done.clone().text()).toBe(200);
        const handed = await handing;
        expect(handed.status, await handed.clone().text()).toBe(200);
      },
    );

    hook.watchInstance = '';
    expect(hook.lockedIds, '乙提交前应无等待地取得 X 的 UPDATE 锁').toContain(x.id);
    expect(hook.republished).toEqual([a.id]);
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
  it('交接使 I2 在同一事务内合席结束：重发返回与 I2 持久化时 Z 仍启用；提交后 Z 停用，仅多一条 auto_disable', async () => {
    const w = await s4World(database().db, 's7e1-59-handover-close');
    const { process, z, instance } = await reenabledWithCountersign(w);
    const successor = w.head.userId; // 已占本节点一席的人接任：U 的席位并入其席位，节点办结
    const trailBefore = await audits(w, z.id);
    hook.republished = [];
    const seen: { at: string; variable: string; instance: string }[] = [];
    hook.watchInstance = instance.id;
    hook.observe = async (at, tx) => {
      const [row] = rowsOf<{ variable: string; instance: string }>(
        await (tx as Tx).execute(sql`SELECT
          (SELECT status FROM approval_variables
            WHERE tenant_id=${w.tenant.id}::uuid AND id=${z.id}::uuid) AS variable,
          (SELECT status FROM approval_instances
            WHERE tenant_id=${w.tenant.id}::uuid AND id=${instance.id}::uuid) AS instance`),
      );
      seen.push({ at, ...row! });
    };

    const handed = await handoverRequest(w, w.exceptionAdmin, successor);
    hook.watchInstance = '';
    hook.observe = async () => undefined;
    expect(handed.status, await handed.clone().text()).toBe(200);

    // 同一事务内：重发返回时 Z 仍启用；I2 在本事务内合席结束（持久化时已 approved），Z 依然启用——收尾在提交前才执行
    expect(hook.republished).toEqual([process.id]);
    const returned = seen.filter((item) => item.at === 'republish-returned');
    expect(returned).toEqual([{ at: 'republish-returned', variable: 'enabled', instance: 'running' }]);
    const persisted = seen.filter((item) => item.at === 'instance-persist');
    expect(persisted.length, '交接应在本事务内持久化 I2').toBeGreaterThan(0);
    expect(persisted.at(-1)).toEqual({ at: 'instance-persist', variable: 'enabled', instance: 'approved' });
    expect((await w.detail(instance.id)).status).toBe('approved');

    // 提交后：Z 停用，操作者为交接操作人、reason“不再被引用”，且只多了这一条对应审计
    const after = await readProcess(w, process.id);
    expect(after.currentVersion!.versionNo).toBe(3);
    expect(after.currentVersion!.exceptionAdminUserId).toBe(successor);
    expect((await varRow(w, z.id)).status).toBe('disabled');
    const trail = await audits(w, z.id);
    expect(trail).toHaveLength(trailBefore.length + 1);
    expect(actionsOf(trail).filter((action) => action === 'auto_disable')).toHaveLength(1);
    const last = trail.at(-1)!;
    expect(last.action).toBe('approval.public_variable.auto_disable');
    expect(last.actor).toBe(w.hr.id);
    expect(last.after).toMatchObject({ reason: '不再被引用' });
  });

  it.runIf(realPostgres)('⑤ 已有 X 锁不阻止交接重发抵达屏障，逐单结束后才在提交前等 X', async () => {
    const w = await s4World(database().db, 's7e2-59-handover-flush');
    const { z, x, instance } = await reenabledWithCountersign(w, true);
    let blocker = 0;
    let reached!: () => void;
    let release!: () => void;
    const atBoundary = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withHeldLock(
      {
        run: (fn) => withTenant(w.db, w.tenant.id, fn),
        take: async (tx) => {
          const [row] = rowsOf<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`));
          blocker = row!.pid;
          await tx.execute(sql`SELECT id FROM approval_variables WHERE tenant_id=${w.tenant.id}
            AND id=${x.id}::uuid FOR UPDATE`);
        },
      },
      async (holder) => {
        hook.observe = async (point) => {
          if (point === 'republish-returned') {
            reached();
            await gate;
          }
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await withRelease(
            async () => {
              release();
              await holder.release();
            },
            async ({ track }) => {
              const handing = track(handoverRequest(w, w.exceptionAdmin, w.head.userId));
              await Promise.race([
                atBoundary,
                handing.then(() => {
                  throw new Error('交接提前结束，未到重发屏障');
                }),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error('两秒内未到达重发屏障')), 2000);
                }),
              ]);
              expect(await lockWaiters(w.db)).toBe(0);
              release();
              expect(await settledOrBlocked(w.db, handing, 1), '交接逐单结束后应在提交前等待 X').toBe('blocked');
              const waiter = await waitingSession(w.db);
              expect(waiter.query).toMatch(/approval_variables.*for update/is);
              expect(waiter.blockers).toContain(blocker);
              await holder.release();
              const response = await handing;
              expect(response.status, await response.clone().text()).toBe(200);
            },
          );
        } finally {
          clearTimeout(timer);
          hook.observe = async () => undefined;
        }
      },
    );
    expect((await w.detail(instance.id)).status).toBe('approved');
    expect((await varRow(w, x.id)).status).toBe('enabled');
    expect((await varRow(w, z.id)).status).toBe('disabled');
    expect((await lastAudit(w, z.id)).after).toMatchObject({ reason: '不再被引用' });
    expect(await lockWaiters(w.db)).toBe(0);
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

  it('P3 对不存在的变量取锁：查询返回零行，台账不登记（仍为空）；之后读取仍是原业务错误 APPROVAL_VARIABLE_NOT_FOUND', async () => {
    const w = await s4World(database().db, 's7e1-59-ledger-missing');
    const ghost = randomUUID();
    const ctx = context(w);

    await withTenant(w.db, w.tenant.id, async (tx) => {
      await lockVariableBatch(tx, ctx, [{ id: ghost, mode: 'update' }]);
      const ledger = transactionLockLedger(tx);
      expect(ledger.held(ghost), '没取到任何行，不能记为已持锁').toBeUndefined();
      expect(ledger.empty()).toBe(true);
      await expect(loadVariable(tx, w.tenant.id, ghost, true)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        details: { reason: 'APPROVAL_VARIABLE_NOT_FOUND' },
      });
    });
  });

  it('P3 一批里有真变量 X 与不存在的 G：只登记 X；随后对 G 的锁定读取仍是业务错误，不是台账程序错误', async () => {
    const w = await s4World(database().db, 's7e1-59-ledger-mixed');
    const process = await w.publish(await create(w, [single('n1', w.near.userId)]));
    const x = await autoAt(w, process.id, 'n1');
    const ghost = randomUUID();
    const ctx = context(w);

    await withTenant(w.db, w.tenant.id, async (tx) => {
      await lockVariableBatch(tx, ctx, [
        { id: x.id, mode: 'update' },
        { id: ghost, mode: 'update' },
      ]);
      const ledger = transactionLockLedger(tx);
      expect(ledger.held(x.id)).toBe('update');
      expect(ledger.held(ghost)).toBeUndefined();
      await expect(loadVariable(tx, w.tenant.id, ghost, true)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        details: { reason: 'APPROVAL_VARIABLE_NOT_FOUND' },
      });
      // 真变量仍可重入
      expect((await loadVariable(tx, w.tenant.id, x.id, true)).id).toBe(x.id);
    });
  });
});
