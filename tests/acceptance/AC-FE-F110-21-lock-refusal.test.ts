/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F110-21（DEC-954 / DEC-955）登记恢复记录被拒的四类分流：锁被他页占用、浏览器不支持锁、
 * 别页已登记同一条目 / 恢复槽、其他持久化失败。四类都不发出业务请求、保留输入、提示各自的专门文案；
 * 不支持锁时不退回无锁读写（不降级）。各修点补“修前合法路径仍成功”的正例。期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdLock, installWebLocks } from './support/web-locks.js';

const RECORDS = 'italent.commands.pending:transfer';
const LOCK_BUSY = '检测到你在另一个标签页打开了此单据，请关闭后重试。';
const UNSUPPORTED = '当前浏览器环境不支持安全保存（需 https 访问），命令未发出。';
const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
const UNAVAILABLE = '无法保存处理状态，命令未发出，请检查浏览器存储设置后重试。';
// 他页持锁超过这个时长才判为“锁被占用”；短暂的互斥（别页正在登记）照常排队。
const LOCK_WAIT_MS = 3000;

installWebLocks();
const { transferCommands: commands } = await import('../../apps/web/src/transfer/commands.js');

const sent: string[] = [];
/** 命令发出即记下 ID；回执是确定成功（201 + 本命令对象），记录随即删除。 */
const send = async (command: { id: string }) => {
  sent.push(command.id);
  return { id: 'synthetic-business', revision: 4 };
};
const values = { place: '合成工作地' };
const input = (commandId: string) => ({
  values,
  baseline: { place: '原工作地' },
  editableFields: ['place'],
  revision: 3,
  commandId,
  send,
});
const scoped = (name: string) => JSON.stringify([randomUUID(), 'synthetic-user', name]);
const recorded = () =>
  (JSON.parse(localStorage.getItem(RECORDS) ?? '[]') as { commandId: string }[]).map((r) => r.commandId);
const message = (key: string) => (commands.get(key)?.error as Error | undefined)?.message;
/** 拒绝后：未发出、未登记、输入原样保留、可再次提交（不是只读锁定）。 */
function expectRefused(key: string, text: string) {
  expect(sent).toEqual([]);
  expect(recorded()).toEqual([]);
  expect(commands.get(key)).toMatchObject({ status: 'rejected', values });
  expect(message(key)).toBe(text);
}

beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  installWebLocks();
});

describe('AC-FE-F110-21 DEC-954 锁被他页占用', () => {
  it('他页一直持锁：等锁超时后拒绝，提示专门文案、不发出、保留输入；他页释放后重提照常发出', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const key = scoped('/api/tenant/employment/transfers/employees/synthetic-e1');
    const release = await holdLock(RECORDS);
    try {
      const pending = commands.submit(key, input('synthetic-command-busy'));
      await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS);
      expectRefused(key, LOCK_BUSY);
      expect(message(key)).not.toBe(OTHER_TAB);
      await pending;
    } finally {
      release();
    }
    const state = await commands.submit(key, input('synthetic-command-after'));
    expect(sent).toEqual(['synthetic-command-after']);
    expect(state.status).toBe('done');
  });

  it('正例：他页短暂持锁（未超过等待时长）时排队，释放后照常登记并发出', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const key = scoped('/api/tenant/employment/transfers/employees/synthetic-e2');
    const release = await holdLock(RECORDS);
    const pending = commands.submit(key, input('synthetic-command-queued'));
    await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS - 1000);
    expect(commands.get(key)?.status).toBe('submitting');
    expect(sent).toEqual([]);
    release();
    const state = await pending;
    expect(sent).toEqual(['synthetic-command-queued']);
    expect(state.status).toBe('done');
  });
});

describe('AC-FE-F110-21 DEC-955 浏览器不支持 Web Locks', () => {
  it('没有 navigator.locks：提示需 https，不发出、不登记，不退回无锁读写', async () => {
    Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
    const key = scoped('/api/tenant/employment/transfers/employees/synthetic-e3');
    await commands.submit(key, input('synthetic-command-insecure'));
    expectRefused(key, UNSUPPORTED);
    // 再提交一次仍拒绝：不因上次失败改走无锁登记。
    await commands.submit(key, input('synthetic-command-insecure-2'));
    expectRefused(key, UNSUPPORTED);
  });
});

describe('AC-FE-F110-21 原有两类分流不变', () => {
  it('别页已登记同一恢复槽的命令：仍提示“其他标签页有该对象未确认的命令”', async () => {
    const slot = scoped('/api/tenant/employment/transfers');
    const key = scoped('/api/tenant/employment/transfers/employees/synthetic-e4');
    const other = { key: scoped('/api/tenant/employment/transfers/employees/synthetic-e5'), slots: [slot] };
    localStorage.setItem(RECORDS, JSON.stringify([{ ...other, commandId: 'synthetic-command-other' }]));
    commands.pin([slot], key);
    await commands.submit(key, input('synthetic-command-mine'));
    expect(sent).toEqual([]);
    expect(recorded()).toEqual(['synthetic-command-other']);
    expect(commands.get(key)).toMatchObject({ status: 'rejected', values });
    expect(message(key)).toBe(OTHER_TAB);
  });

  it('恢复记录损坏（其他持久化失败）：仍提示“无法保存处理状态”', async () => {
    const key = scoped('/api/tenant/employment/transfers/employees/synthetic-e6');
    localStorage.setItem(RECORDS, '{"损坏":');
    await commands.submit(key, input('synthetic-command-corrupt'));
    expect(sent).toEqual([]);
    expect(localStorage.getItem(RECORDS)).toBe('{"损坏":');
    expect(commands.get(key)).toMatchObject({ status: 'rejected', values });
    expect(message(key)).toBe(UNAVAILABLE);
  });

  it('正例：锁可用、无占用时照常登记并发出', async () => {
    const key = scoped('/api/tenant/employment/transfers/employees/synthetic-e7');
    const state = await commands.submit(key, input('synthetic-command-ok'));
    expect(sent).toEqual(['synthetic-command-ok']);
    expect(state.status).toBe('done');
  });
});
