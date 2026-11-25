/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-110 DEC-954 / DEC-955 第 2 轮返工（内核层）。各“标签页”是同一份配置的独立存储，共用 localStorage 与 Web Locks，
 * 与浏览器同源多标签页的口径一致。期望值手写。
 * - AC-FE-F110-24：非安全上下文里 navigator.locks 与 crypto.randomUUID 都没有，调动 / 审批在生成命令 ID 之前
 *   就按 DEC-955 拒绝（专门文案、零发送）；组织调整（requireLocks:false）没有 randomUUID 也照常保存。
 * - AC-FE-F110-26：两页同一刻提交同一条目，后登记的一页拿到自己的“其他标签页”拒绝原因，同时锁到先登记那页的命令上。
 * - AC-FE-F110-28：登记被拒（未登记）的命令不排清理锁请求；已登记的命令落定后照常删记录。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdLock, installWebLocks } from './support/web-locks.js';

const TRANSFER = 'italent.commands.pending:transfer';
const UNSUPPORTED = '当前浏览器环境不支持安全保存（需 https 访问），命令未发出。';
const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
const LOCK_WAIT_MS = 3000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

installWebLocks();
const { createFormStore } = await import('../../apps/web/src/foundation/forms/store.js');
const { sharedRecovery } = await import('../../apps/web/src/foundation/forms/recovery.js');
/** 一个标签页的命令存储，配置与产品代码相同（transfer/commands.ts、approval/commands.ts、org-adjustment/commands.ts）。 */
const tab = (name: 'transfer' | 'approval' | 'org-adjustment') =>
  createFormStore({ recovery: sharedRecovery(name, name === 'org-adjustment' ? { requireLocks: false } : {}) });

const sent: string[] = [];
const send = async (command: { id: string }) => {
  sent.push(command.id);
  return { id: 'synthetic-business', revision: 4 };
};
const values = { place: '合成工作地' };
/** 不带 commandId：审批、HR 调动、组织调整都由内核生成命令 ID。 */
const input = (deliver: typeof send = send) => ({
  values,
  baseline: { place: '原工作地' },
  editableFields: ['place'],
  revision: 3,
  send: deliver,
});
const scoped = (name: string) => JSON.stringify([randomUUID(), 'synthetic-user', name]);
const recorded = (name = TRANSFER) =>
  (JSON.parse(localStorage.getItem(name) ?? '[]') as { commandId: string }[]).map((r) => r.commandId);
const message = (state?: { error?: unknown }) => (state?.error as Error | undefined)?.message;
const pendingLocks = async (name: string) =>
  (await navigator.locks.query()).pending?.filter((lock) => lock.name === name).length;
/** 提交抛错（例如生成命令 ID 时 TypeError）也落成可断言的结果，按断言判红而不是按异常。 */
const outcome = (pending: Promise<{ status: string; error?: unknown }>) =>
  pending.catch((thrown: unknown) => ({ status: 'threw', error: thrown as Error }));
/** 非安全上下文：两项 API 都不可用（Web Cryptography 只在安全上下文提供 randomUUID，getRandomValues 仍在）。 */
function insecureContext(locks = true) {
  if (locks) Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
}

beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
  installWebLocks();
});

describe('AC-FE-F110-24 DEC-955 非安全上下文：生成命令 ID 之前就拒绝', () => {
  for (const name of ['transfer', 'approval'] as const) {
    it(`${name}：没有 locks 与 randomUUID 时提示需 https、零发送、不登记，输入保留可再提交`, async () => {
      insecureContext();
      const commands = tab(name);
      const key = scoped(`/api/tenant/${name}/synthetic-object`);
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = await outcome(commands.submit(key, input()));
        expect(state).toMatchObject({ status: 'rejected', values });
        expect(message(state)).toBe(UNSUPPORTED);
      }
      expect(sent).toEqual([]);
      expect(localStorage.length).toBe(0);
    });
  }

  it('组织调整（requireLocks:false）没有 locks 与 randomUUID 时照常登记并保存，命令 ID 仍是 UUID v4', async () => {
    insecureContext();
    const state = await outcome(tab('org-adjustment').submit(scoped('/api/tenant/org-adjustments'), input()));
    expect(state.status).toBe('done');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(UUID);
  });

  it('正例：安全上下文（locks 与 randomUUID 都在）时调动照常登记并发出', async () => {
    const state = await tab('transfer').submit(scoped('/api/tenant/employment/transfers/employees/e0'), input());
    expect(state.status).toBe('done');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(UUID);
  });

  it('锁可用、只缺 randomUUID（老版本浏览器）：命令 ID 改由 getRandomValues 生成，调动照常登记并发出', async () => {
    insecureContext(false);
    const key = scoped('/api/tenant/employment/transfers/employees/e1');
    const state = await outcome(tab('transfer').submit(key, input()));
    expect(state.status).toBe('done');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(UUID);
  });
});

describe('AC-FE-F110-26 同一条目两页同时登记', () => {
  it('后登记的 B 拿到自己的“其他标签页”拒绝，同时锁到 A 的命令上；A 的恢复记录保留', async () => {
    const key = scoped('/api/tenant/employment/transfers/employees/e2');
    const pageA = tab('transfer');
    const pageB = tab('transfer');
    // A 发出后一直没有回执（结果待定）。
    const first = pageA.submit(
      key,
      input((command) => (sent.push(command.id), new Promise(() => {}))),
    );
    const second = await pageB.submit(key, input());
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const commandA = pageA.get(key)!.command!.id;
    expect(second.status).toBe('rejected');
    expect(message(second)).toBe(OTHER_TAB);
    expect(second.command?.id).not.toBe(commandA);
    expect(pageB.get(key)).toMatchObject({ status: 'unknown', restored: true, command: { id: commandA } });
    expect(recorded()).toEqual([commandA]);
    expect(sent).toEqual([commandA]);
    void first;
  });

  it('正例：A 已落定后 B 再提交同一条目照常登记并发出', async () => {
    const key = scoped('/api/tenant/employment/transfers/employees/e3');
    const pageA = tab('transfer');
    const pageB = tab('transfer');
    expect((await pageA.submit(key, input())).status).toBe('done');
    expect((await pageB.submit(key, input())).status).toBe('done');
    expect(sent).toHaveLength(2);
    expect(recorded()).toEqual([]);
  });
});

describe('AC-FE-F110-28 未登记的命令不排清理锁请求', () => {
  it('他页持锁、本页等锁超时被拒后，没有本次尝试残留的排队请求', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const commands = tab('transfer');
    const key = scoped('/api/tenant/employment/transfers/employees/e4');
    const release = await holdLock(TRANSFER);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const pending = commands.submit(key, input());
        await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS);
        expect((await pending).status).toBe('rejected');
        expect(await pendingLocks(TRANSFER)).toBe(0);
      }
    } finally {
      release();
    }
    expect(sent).toEqual([]);
  });

  it('正例：已登记的命令落定后照常删记录，锁随即放开', async () => {
    const state = await tab('transfer').submit(scoped('/api/tenant/employment/transfers/employees/e5'), input());
    expect(state.status).toBe('done');
    await vi.waitFor(() => expect(recorded()).toEqual([]));
    expect(await pendingLocks(TRANSFER)).toBe(0);
  });
});
