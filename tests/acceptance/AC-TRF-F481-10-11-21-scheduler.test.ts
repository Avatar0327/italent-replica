/** F-481 S3c：只调用本片调度与已合入 S1/S2/S3a，不依赖签署记录或下载。 */
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { runContractJobs, startContractScheduler } from '../../apps/api/src/modules/contracts/scheduler.js';
import { applySignEvent } from '../../apps/api/src/modules/esign/sign-events.js';
import * as notifications from '../../apps/api/src/modules/approval/notifications.js';
import { mineWorld } from './AC-TRF-F481-s3a-support.js';
import { rows } from './AC-TRF-F481-s2-support.js';

// 红提交：基线无电子签调度，运行 server.ts 已有的真实合同调度；以任务/通知断言证明缺口，
// 不把 import 失败或函数不存在算红证据。实现提交改为直接静态导入本片调度。
interface SchedulerModule {
  runESignJobs(db: Db, options: { clock: () => Date; onError?: (error: unknown) => void }): Promise<unknown>;
  startESignScheduler(db: Db, options: { clock: () => Date; intervalMs?: number }): { stop(): Promise<void> };
}
const modules = import.meta.glob<SchedulerModule>('../../apps/api/src/modules/esign/scheduler.ts', { eager: true });
const scheduler = Object.values(modules)[0] ?? {
  runESignJobs: (db: Db, options: { clock: () => Date }) => runContractJobs(db, {}, options),
  startESignScheduler: (db: Db, options: { clock: () => Date; intervalMs?: number }) =>
    startContractScheduler(db, options),
};
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
