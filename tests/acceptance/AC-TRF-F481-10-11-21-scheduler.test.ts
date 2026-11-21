/** F-481 S3c：只调用本片调度与已合入 S1/S2/S3a，不依赖签署记录或下载。 */
import { randomUUID } from 'node:crypto';
import { employmentBusinessObjects, esignTasks, esignTaskFiles, sql, withTenant, withPlatform } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import * as scheduler from '../../apps/api/src/modules/esign/scheduler.js';
import { applySignEvent } from '../../apps/api/src/modules/esign/sign-events.js';
import { simulatedProvider } from '../../apps/api/src/modules/esign/provider.js';
import * as notifications from '../../apps/api/src/modules/approval/notifications.js';
import { mineWorld } from './AC-TRF-F481-s3a-support.js';
import { rows } from './AC-TRF-F481-s2-support.js';

const database = useTestDb();
const REMIND_AT = new Date('2026-10-11T01:00:00.000Z');
const EXPIRE_AT = new Date('2026-10-12T01:00:00.000Z');
type World = Awaited<ReturnType<typeof mineWorld>>;
async function settings(w: World, enabled: boolean) {
  const current = (await (await w.hr('GET', '/scenes/transfer')).json()) as { revision: number };
  const response = await w.hr('PUT', '/scenes/transfer', {
    ifMatch: current.revision,
    body: { validityDays: 2, remindBeforeExpiry: enabled },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}
async function world(label: string, remind = true) {
  const w = await mineWorld(database().db, `scheduler-${label}`);
  await settings(w, remind);
  await w.direct();
  const [task] = await w.tasks();
  expect(task).toMatchObject({ status: 'signing', expiresAt: EXPIRE_AT, remindBeforeExpiry: remind });
  return { w, task: task! };
}
const round = (now: Date, onError?: (error: unknown) => void) =>
  scheduler.runESignJobs(database().db, { clock: () => now, ...(onError ? { onError } : {}) });
async function ledger(w: World, id: string) {
  return withTenant(w.db, w.tenantId, async (tx) =>
    rows<{ command_id: string }>(
      await tx.execute(sql`SELECT command_id FROM command_ledger
        WHERE tenant_id=${w.tenantId} AND command_id LIKE ${`esign:%${id}%`} ORDER BY command_id`),
    ),
  );
}
async function failures(w: World, id: string) {
  return withTenant(w.db, w.tenantId, async (tx) =>
    rows<{ outcome: string; error_code: string }>(
      await tx.execute(sql`SELECT outcome,error_code FROM audit_command_failures
        WHERE tenant_id=${w.tenantId} AND command_id LIKE ${`esign:%${id}%`}`),
    ),
  );
}

describe('AC-TRF-F481-10 / 11 / 21 定时过期与提醒', () => {
  it('10 / 21 启动首轮到期置 expired，再跑一轮完全不变；无通知、无新任务', async () => {
    const { w, task } = await world('expire');
    const running = scheduler.startESignScheduler(w.db, { clock: () => EXPIRE_AT });
    await running.stop();
    const after = await w.tasks();
    expect(after[0]?.status, '到期首轮必须将 signing 置为 expired').toBe('expired');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ currentNode: null, expiredAt: EXPIRE_AT, revision: task.revision + 1 });
    expect(await w.notices()).toEqual([]);
    const audits = await w.audits(task.id);
    expect(audits.map((a) => a.action)).toEqual(['esign.task.expired', 'esign.task.initiated']);
    await round(new Date(EXPIRE_AT.getTime() + 1));
    expect(await w.tasks()).toEqual(after);
    expect(await w.audits(task.id)).toEqual(audits);
    expect(await w.notices()).toEqual([]);
  });

  it('11 / 21 到期前 24h 边界提醒一次，快照开启后关闭配置仍提醒；租户时区文案', async () => {
    const { w, task } = await world('remind');
    await settings(w, false);
    await round(new Date(REMIND_AT.getTime() - 1));
    expect(await w.notices()).toEqual([]);
    expect(await w.tasks()).toEqual([task]);
    await round(REMIND_AT);
    const notices = await w.notices();
    expect(notices, '到期前 24h 员工必须收到一条提醒').toHaveLength(1);
    expect(notices[0]).toMatchObject({
      template_code: 'esign_remind',
      recipient_user_id: w.employeeUser,
      business_type: 'esign_task',
      business_id: task.id,
      payload: { 场景: '调动电子签署', 文件名称: 'ZZ_F481_A、ZZ_F481_B', 截止时间: '2026-10-12 09:00' },
    });
    const after = await w.tasks();
    expect(after[0]).toMatchObject({ status: 'signing', currentNode: 'employee', expiryRemindedAt: REMIND_AT });
    const audits = await w.audits(task.id);
    expect(audits.map((a) => a.action)).toEqual(['esign.task.initiated', 'esign.task.reminded']);
    expect(audits[1]?.after).toMatchObject({ recipientUserId: w.employeeUser, method: 'expiry_remind' });
    expect(await ledger(w, task.id)).toEqual([{ command_id: `esign:${task.id}:expiry_remind:${w.employeeUser}` }]);
    await round(new Date(REMIND_AT.getTime() + 1));
    expect(await w.notices()).toEqual(notices);
    expect(await w.tasks()).toEqual(after);
    expect(await w.audits(task.id)).toEqual(audits);
  });

  it('11 关闭提醒时发起的任务，事后开启配置仍不提醒（快照）', async () => {
    const { w, task } = await world('off', false);
    await settings(w, true);
    await round(REMIND_AT);
    expect(await w.notices()).toEqual([]);
    expect(await w.tasks()).toEqual([task]);
    expect((await w.audits(task.id)).map((a) => a.action)).toEqual(['esign.task.initiated']);
  });

  it('11 员工已确认、企业未确认不提醒企业节点；企业节点仍到期过期', async () => {
    const { w, task } = await world('enterprise');
    const ready = await withTenant(w.db, w.tenantId, (tx) =>
      applySignEvent(tx, w.ctx(), task, {
        type: 'node_signed',
        node: 'employee',
        actorUserId: w.employeeUser,
        at: w.ctx().now,
      }),
    );
    await round(REMIND_AT);
    expect(await w.notices()).toEqual([]);
    expect(await w.tasks()).toEqual([ready]);
    await round(EXPIRE_AT);
    expect((await w.tasks())[0]?.status).toBe('expired');
    expect(await w.notices()).toEqual([]);
  });

  it('10 / 11 已到期优先过期，停机跨过整个提醒窗口不补提醒', async () => {
    const { w } = await world('late');
    await round(new Date(EXPIRE_AT.getTime() + 7 * 86400000));
    expect((await w.tasks())[0]?.status).toBe('expired');
    expect((await w.tasks())[0]?.expiryRemindedAt).toBeNull();
    expect(await w.notices()).toEqual([]);
    expect(await w.tasks()).toHaveLength(1);
  });

  it('11 / 21 提醒写入后抛错：通知、标记、成功审计和台账回滚，失败留审计，下轮重试一次', async () => {
    const { w, task } = await world('rollback');
    const before = await w.audits(task.id);
    const original = notifications.notifyMessage;
    const spy = vi.spyOn(notifications, 'notifyMessage').mockImplementation(async (...args) => {
      await original(...args);
      if ('businessId' in args[2] && args[2].businessId === task.id) throw new Error('SYN_NOTICE_AFTER_INSERT');
    });
    const errors: unknown[] = [];
    try {
      await round(REMIND_AT, (error) => errors.push(error));
    } finally {
      spy.mockRestore();
    }
    expect(await w.tasks()).toEqual([task]);
    expect(await w.notices()).toEqual([]);
    expect(await w.audits(task.id)).toEqual(before);
    expect(await ledger(w, task.id)).toEqual([]);
    expect(await failures(w, task.id), '失败动作必须记录失败审计').toEqual([
      { outcome: 'business_failed', error_code: 'INTERNAL_ERROR' },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    await round(REMIND_AT);
    await round(REMIND_AT);
    expect(await w.notices()).toHaveLength(1);
    expect((await w.audits(task.id)).filter((a) => a.action === 'esign.task.reminded')).toHaveLength(1);
  });

  it('10 / 11 两轮并发仍仅提醒一次和过期一次', async () => {
    const { w, task } = await world('concurrent');
    await Promise.all([round(REMIND_AT), round(REMIND_AT)]);
    expect(await w.notices()).toHaveLength(1);
    expect((await w.audits(task.id)).filter((a) => a.action === 'esign.task.reminded')).toHaveLength(1);
    await Promise.all([round(EXPIRE_AT), round(EXPIRE_AT)]);
    expect((await w.tasks())[0]?.status).toBe('expired');
    expect((await w.audits(task.id)).filter((a) => a.action === 'esign.task.expired')).toHaveLength(1);
    expect(await w.tasks()).toHaveLength(1);
  });
});

describe('AC-TRF-F481-10 / 11 / 21 调度隔离与恢复边界', () => {
  it('10 / 21 过期写审计后失败整条回滚，其他租户继续；下轮重试仅过期一次', async () => {
    const a = await world('expire-failure');
    const b = await world('expire-healthy');
    const before = await a.w.audits(a.task.id);
    const original = simulatedProvider.revoke;
    const spy = vi.spyOn(simulatedProvider, 'revoke').mockImplementation(async (input) => {
      if (input.taskId === a.task.id) throw new Error('SYN_EXPIRE_FAILED');
      return original(input);
    });
    const errors: unknown[] = [];
    try {
      await round(EXPIRE_AT, (error) => errors.push(error));
    } finally {
      spy.mockRestore();
    }
    expect(await a.w.tasks()).toEqual([a.task]);
    expect(await a.w.audits(a.task.id)).toEqual(before);
    expect(await ledger(a.w, a.task.id)).toEqual([]);
    expect(await failures(a.w, a.task.id)).toHaveLength(1);
    expect((await b.w.tasks())[0]?.status).toBe('expired');
    expect(errors).toHaveLength(1);
    await round(EXPIRE_AT);
    await round(EXPIRE_AT);
    expect((await a.w.tasks())[0]?.status).toBe('expired');
    expect((await a.w.audits(a.task.id)).filter((a) => a.action === 'esign.task.expired')).toHaveLength(1);
    expect(await a.w.notices()).toEqual([]);
  });

  it('10 / 11 / 21 单租户 101 条跨页：失败不挡后续任务、另一租户；失败次数逐轮留存且可重试', async () => {
    const { w, task } = await world('pages');
    const other = await world('pages-other');
    const files = await w.files(task.id);
    // 规模夹具用 S1 已合入表契约造 100 条合成任务；正常业务流程由上述 HTTP + S2 用例覆盖。
    await withTenant(w.db, w.tenantId, async (tx) => {
      for (let index = 0; index < 100; index += 1) {
        const businessId = randomUUID();
        const id = randomUUID();
        await tx
          .insert(employmentBusinessObjects)
          .values({ id: businessId, tenantId: w.tenantId, employeeId: task.employeeId });
        await tx.insert(esignTasks).values({ ...task, id, businessId });
        await tx.insert(esignTaskFiles).values(files.map((file) => ({ ...file, taskId: id })));
      }
    });
    const original = notifications.notifyMessage;
    const spy = vi.spyOn(notifications, 'notifyMessage').mockImplementation(async (...args) => {
      if ('businessId' in args[2] && args[2].businessId === task.id) throw new Error('SYN_ONE_BAD_TASK');
      return original(...args);
    });
    const errors: unknown[] = [];
    try {
      await round(REMIND_AT, (error) => errors.push(error));
      await round(REMIND_AT, (error) => errors.push(error));
    } finally {
      spy.mockRestore();
    }
    expect(await w.notices()).toHaveLength(100);
    expect(await other.w.notices()).toHaveLength(1);
    expect((await w.tasks()).filter((t) => t.expiryRemindedAt !== null)).toHaveLength(100);
    expect(await failures(w, task.id)).toHaveLength(2);
    expect(errors).toHaveLength(2);
    await round(REMIND_AT);
    expect(await w.notices()).toHaveLength(101);
    await round(EXPIRE_AT);
    expect((await w.tasks()).filter((t) => t.status === 'expired')).toHaveLength(101);
    expect(await w.notices()).toHaveLength(101);
  });

  it('10 / 11 终态不动、不重试发起；停用租户不扫描，另一租户仍正常运行', async () => {
    const a = await world('terminal');
    const b = await world('inactive');
    const c = await world('active');
    await a.w.revoke(a.task);
    const snapshot = { tasks: await a.w.tasks(), notices: await a.w.notices(), audits: await a.w.audits(a.task.id) };
    await withPlatform(b.w.db, (tx) => tx.execute(sql`UPDATE tenants SET status='suspended' WHERE id=${b.w.tenantId}`));
    try {
      await round(REMIND_AT);
      expect(await b.w.tasks()).toEqual([b.task]);
      expect(await b.w.notices()).toEqual([]);
      expect(await c.w.notices()).toHaveLength(1);
      await round(EXPIRE_AT);
      expect(await a.w.tasks()).toEqual(snapshot.tasks);
      expect(await a.w.notices()).toEqual(snapshot.notices);
      expect(await a.w.audits(a.task.id)).toEqual(snapshot.audits);
      expect(await b.w.tasks()).toEqual([b.task]);
      expect((await c.w.tasks())[0]?.status).toBe('expired');
    } finally {
      await withPlatform(b.w.db, (tx) => tx.execute(sql`UPDATE tenants SET status='active' WHERE id=${b.w.tenantId}`));
    }
  });

  it('11 截止时间按租户 America/Chicago 时区，提醒仍按 24 小时窗口', async () => {
    const { w, task } = await world('timezone');
    await withPlatform(w.db, (tx) =>
      tx.execute(sql`UPDATE tenants SET timezone='America/Chicago' WHERE id=${w.tenantId}`),
    );
    await round(REMIND_AT);
    expect((await w.notices())[0]).toMatchObject({
      business_id: task.id,
      recipient_user_id: w.employeeUser,
      payload: { 截止时间: '2026-10-11 20:00' },
    });
  });

  it('10 / 11 启动立即执行、慢轮次不重叠；stop 等待在途事务并停止后续轮次', async () => {
    const { w, task } = await world('stop');
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = simulatedProvider.remind;
    const spy = vi.spyOn(simulatedProvider, 'remind').mockImplementation(async (input) => {
      if (input.taskId === task.id) {
        entered();
        await blocked;
      }
      return original(input);
    });
    const clock = vi.fn(() => REMIND_AT);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const running = scheduler.startESignScheduler(w.db, { clock, intervalMs: 1000 });
    try {
      await started;
      await vi.advanceTimersByTimeAsync(5000);
      // 本轮只在选候选和取得该任务锁后各取一次时钟。
      expect(clock).toHaveBeenCalledTimes(2);
      let stopped = false;
      const stopping = running.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(await w.notices()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(clock).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await running.stop();
      vi.useRealTimers();
      spy.mockRestore();
    }
  });

  it.each([0, 999, 1.1, NaN, Infinity, 2147483648])('10 调度间隔 %s 不合法时拒绝启动', (intervalMs) => {
    expect(() => scheduler.startESignScheduler(database().db, { intervalMs })).toThrow(RangeError);
  });
});
