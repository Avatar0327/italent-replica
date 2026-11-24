/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F110-29（F-110 第 4 轮 P2-1 / P2-2）内核单一出口：提交结果显式带出“竞争”（原因 + 占槽命令 ID），
 * B 的拒绝落定后恢复槽对齐到仍未确认的那条命令，与 storage 事件、登记失败的先后无关。
 * 别的标签页的登记用“锁内写入共用记录 + storage 事件”模拟（与浏览器里 B 看到的一致），事件时点由测试控制。
 * 页面声明本命令涉及的槽（第三个参数）；同时按页面层旧口径先把槽钉到本条目，两种写法在内核里结果相同。期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdLock, installWebLocks } from './support/web-locks.js';

installWebLocks();
const { createFormStore } = await import('../../apps/web/src/foundation/forms/store.js');
const { sharedRecovery } = await import('../../apps/web/src/foundation/forms/recovery.js');

const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
const LOCK_BUSY = '检测到你在另一个标签页打开了此单据，请关闭后重试。';
const LOCK_WAIT_MS = 3000;
type Store = ReturnType<typeof createFormStore>;
type Submit = (key: string, input: unknown, claim?: readonly string[]) => ReturnType<Store['submit']>;

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

/** 每条用例一份独立的共用记录名：同一页面里的存储互不串扰。 */
function setup() {
  const name = `f110-29-${randomUUID()}`;
  const records = `italent.commands.pending:${name}`;
  const scoped = (path: string) => JSON.stringify(['synthetic-tenant', 'synthetic-user', path]);
  const slot = scoped('/api/tenant/employment/transfers');
  const keyA = scoped('/api/tenant/employment/transfers/employees/synthetic-a');
  const keyB = scoped('/api/tenant/employment/transfers/employees/synthetic-b');
  const store = createFormStore({ recovery: sharedRecovery(name) });
  const sent: string[] = [];
  const send = vi.fn(async (command: { id: string }) => {
    sent.push(command.id);
    return { id: 'synthetic-employee-b' };
  });
  const input = { values: { place: '合成工作地' }, baseline: {}, editableFields: ['place'], revision: 3, send };
  /** B 提交：声明集合槽，并按旧页面层口径先钉到本条目。 */
  const submitB = (key = keyB) => {
    store.pin([slot], key);
    return (store.submit as Submit)(key, { ...input, businessId: 'synthetic-employee-b' }, [slot]);
  };
  /** 别的标签页 A 的登记：锁内写入共用记录（A 的命令 cmd-a 结果未知，占着集合槽）。 */
  const registerA = (key = keyA) =>
    localStorage.setItem(records, JSON.stringify([{ key, slots: [slot], commandId: 'cmd-a', revision: 3 }]));
  const storageEvent = () => window.dispatchEvent(new StorageEvent('storage', { key: records }));
  return { records, slot, keyA, keyB, store, sent, send, input, submitB, registerA, storageEvent };
}
type Setup = ReturnType<typeof setup>;
const raceOf = (state: unknown) => (state as { race?: unknown }).race;

/** B 仍锁到 A：槽归 A 的条目，按原命令 ID 查询时用的是 A 的 cmd-a。 */
async function expectLockedToA({ store, slot, keyA }: Setup) {
  expect(store.holder([slot])).toBe(keyA);
  expect(store.get(keyA)).toMatchObject({ status: 'unknown', restored: true, command: { id: 'cmd-a' } });
  const asked: string[] = [];
  await store.recoverResult(store.holder([slot])!, async (command) => {
    asked.push(command.id);
    return { status: 'pending' };
  });
  expect(asked).toEqual(['cmd-a']);
}

describe('AC-FE-F110-29 不同员工竞争：拒绝落定后槽对齐到 A（P2-1）', () => {
  it('B 等锁时先收到 A 的 storage 事件、再被登记冲突拒绝：B 仍锁到 A，结果带出竞争原因与 A 的命令 ID', async () => {
    const t = setup();
    const release = await holdLock(t.records);
    const pending = t.submitB();
    await Promise.resolve();
    expect(t.store.get(t.keyB)?.status).toBe('submitting');
    t.registerA();
    t.storageEvent();
    // 事件先到：A 的条目已载入，B 仍在提交中，槽暂不改钉（问 2 正例：交接不从本页处理中的命令手里抢槽）。
    expect(t.store.get(t.keyA)).toMatchObject({ status: 'unknown', restored: true });
    expect(t.store.holder([t.slot])).toBe(t.keyB);
    release();
    const outcome = await pending;
    expect(t.send).not.toHaveBeenCalled();
    expect(outcome.status).toBe('rejected');
    await expectLockedToA(t);
    expect(raceOf(outcome)).toEqual({ reason: OTHER_TAB, commandId: 'cmd-a' });
  });

  it('登记冲突先于 storage 事件：同样锁到 A、带出竞争；迟到的事件不改变结果', async () => {
    const t = setup();
    const release = await holdLock(t.records);
    const pending = t.submitB();
    await Promise.resolve();
    t.registerA();
    release();
    const outcome = await pending;
    t.storageEvent();
    expect(t.send).not.toHaveBeenCalled();
    expect(raceOf(outcome)).toEqual({ reason: OTHER_TAB, commandId: 'cmd-a' });
    await expectLockedToA(t);
  });
});

describe('AC-FE-F110-29 提交前同步就发现占用：同样走竞争出口（P2-2）', () => {
  it('同一员工：A 已登记，B 提交即锁到 A 的命令，零发出，结果带出竞争原因与 A 的命令 ID', async () => {
    const t = setup();
    t.registerA(t.keyB);
    const outcome = await t.submitB();
    expect(t.send).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'unknown', restored: true, command: { id: 'cmd-a' } });
    expect(raceOf(outcome)).toEqual({ reason: OTHER_TAB, commandId: 'cmd-a' });
    expect(t.store.holder([t.slot])).toBe(t.keyB);
  });

  it('不同员工：A 已登记占着集合槽，B 提交零发出、带出竞争，槽锁到 A', async () => {
    const t = setup();
    t.registerA();
    const outcome = await t.submitB();
    expect(t.send).not.toHaveBeenCalled();
    expect(outcome.status).toBe('rejected');
    expect(raceOf(outcome)).toEqual({ reason: OTHER_TAB, commandId: 'cmd-a' });
    await expectLockedToA(t);
  });
});

describe('AC-FE-F110-29 普通拒绝不带竞争（P2-2 反向）', () => {
  it('B 等锁期间 A 登记、B 等锁超时：结果是 DEC-954 拒绝、不带竞争；槽照样对齐到仍未确认的 A', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = setup();
    const release = await holdLock(t.records);
    try {
      const pending = t.submitB();
      await Promise.resolve();
      t.registerA();
      t.storageEvent();
      await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS);
      const outcome = await pending;
      expect(t.send).not.toHaveBeenCalled();
      expect(outcome.status).toBe('rejected');
      expect((outcome.error as Error).message).toBe(LOCK_BUSY);
      expect(raceOf(outcome)).toBeUndefined();
      expect(t.store.holder([t.slot])).toBe(t.keyA);
    } finally {
      release();
    }
  });
});

describe('AC-FE-F110-29 正例：修前合法路径仍成功', () => {
  it('没有竞争：照常登记并发出一次，结果确定、不带竞争', async () => {
    const t = setup();
    const outcome = await t.submitB();
    expect(t.sent).toHaveLength(1);
    expect(outcome.status).toBe('done');
    expect(raceOf(outcome)).toBeUndefined();
    expect(localStorage.getItem(t.records)).toBeNull();
  });

  it('落定时再同步不吞掉本页自己的结果：在途期间别页登记了同一条目，B 的提交结果仍是自己的完成', async () => {
    const t = setup();
    let late!: (value: { id: string }) => void;
    const pending = (t.store.submit as Submit)(
      t.keyB,
      { ...t.input, businessId: 'synthetic-employee-b', send: () => new Promise((resolve) => (late = resolve)) },
      [t.slot],
    );
    await vi.waitFor(() => expect(late).toBeDefined());
    // 别页查到 B 的命令“确定失败”、删了 B 的记录并重提（同 F110-07）：共用记录里只剩别页的 cmd-a。
    t.registerA(t.keyB);
    late({ id: 'synthetic-employee-b' });
    const outcome = await pending;
    expect(outcome.status).toBe('done');
    expect(outcome.restored).toBeFalsy();
    expect(raceOf(outcome)).toBeUndefined();
    expect(t.store.get(t.keyB)?.status).toBe('done');
    // 下一次同步（storage 事件）才锁到别页的命令上。
    t.storageEvent();
    expect(t.store.get(t.keyB)).toMatchObject({ status: 'unknown', restored: true, command: { id: 'cmd-a' } });
    expect(t.store.holder([t.slot])).toBe(t.keyB);
  });

  it('A 落定（记录删掉 + storage 事件）后：槽放开，B 照常发出一次', async () => {
    const t = setup();
    t.registerA();
    t.storageEvent();
    expect(t.store.holder([t.slot])).toBe(t.keyA);
    localStorage.removeItem(t.records);
    t.storageEvent();
    expect(t.store.get(t.keyA)).toBeUndefined();
    const outcome = await t.submitB();
    expect(t.sent).toHaveLength(1);
    expect(outcome.status).toBe('done');
    expect(raceOf(outcome)).toBeUndefined();
  });
});
