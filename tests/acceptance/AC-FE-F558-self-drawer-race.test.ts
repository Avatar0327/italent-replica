/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F558-1（F-558 ①，DEC-954 / F-110 第 4 轮单一出口）员工自助 / 经理调动抽屉：同一单两页同时提交，
 * 后一页本次未发出，提示“其他标签页有该对象未确认的命令”（内核 raceOf 的原因），不只显示“处理中”；
 * 锁到先登记那页的命令；本页自己的未确认命令仍只显示“处理中”，不误报其他标签页。
 * 两个标签页的模拟同 AC-FE-F110-15：每页一份模块实例与会话存储，本地存储两页共用。期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdLock, installWebLocks } from './support/web-locks.js';

installWebLocks();

class MemoryStorage {
  readonly #items = new Map<string, string>();
  get length() {
    return this.#items.size;
  }
  clear() {
    this.#items.clear();
  }
  getItem(key: string) {
    return this.#items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#items.delete(key);
  }
  setItem(key: string, value: string) {
    this.#items.set(key, String(value));
  }
}
const shared = new MemoryStorage();
const RECORDS = 'italent.commands.pending:transfer';
const PROCESSING = '处理中 / 结果待确认';
const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  shared.clear();
});

function enter(tab: { storage: MemoryStorage }) {
  vi.stubGlobal('sessionStorage', tab.storage);
  vi.stubGlobal('localStorage', shared);
}
async function openTab() {
  const tab = { storage: new MemoryStorage() };
  enter(tab);
  vi.resetModules();
  const app = await import('../../apps/web/src/self-service/pages/application-session.js');
  const { ApplicationCommandHandled } = await import('../../apps/web/src/self-service/shared/application-command.js');
  return { ...tab, app, Handled: ApplicationCommandHandled };
}
const storageEvent = () => window.dispatchEvent(new StorageEvent('storage', { key: RECORDS }));
const offline = async (): Promise<never> => {
  throw new TypeError('合成断网');
};
const commandOf = () => ({
  commandId: randomUUID(),
  employeeId: 'synthetic-employee',
  action: 'submit' as const,
  effectiveDate: '2026-11-02',
  summary: { fields: { departmentId: 'synthetic-department' } },
});
// 自助调动提交回执的形状（self-service 调动返回调动单：id、revision、employeeRevision、status）。
const business = () => ({ id: randomUUID(), revision: 1, employeeRevision: 7, status: 'in_review' });
const recorded = () => (JSON.parse(shared.getItem(RECORDS) ?? '[]') as { commandId: string }[]).map((r) => r.commandId);
/** 捕获本次提交的拒绝，断言它是“已处理”且未发出。 */
async function refusal(tab: Awaited<ReturnType<typeof openTab>>, run: Promise<unknown>) {
  const error = await run.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(tab.Handled);
  return error as InstanceType<typeof tab.Handled>;
}

describe('AC-FE-F558-1 自助抽屉两页同时提交走其他标签页提示', () => {
  for (const name of ['employee', 'manager'])
    it(`${name}：A 结果未知期间 B 提交被挡：B 提示其他标签页、不执行，锁到 A 的命令`, async () => {
      const scope = JSON.stringify([randomUUID(), 'synthetic-user', name]);
      const b = await openTab(); // B 在 A 提交前已打开、未收到 storage 事件
      const a = await openTab();
      const first = commandOf();
      enter(a);
      await expect(a.app.runApplicationCommand(scope, first, offline)).rejects.toThrow(PROCESSING);

      enter(b);
      const execute = vi.fn(async () => business());
      const error = await refusal(b, b.app.runApplicationCommand(scope, commandOf(), execute));
      expect(error.message).toBe(OTHER_TAB);
      expect(error.notSent).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(b.app.readApplicationSession(scope)).toMatchObject({
        race: OTHER_TAB,
        restored: true,
        pending: { commandId: first.commandId, employeeId: 'synthetic-employee' },
      });
    });

  it('同一刻登记（他页持锁时两页排队）：只执行 A；B 提示其他标签页并锁到 A 的命令；A 落定后 B 解锁可再提交', async () => {
    const scope = JSON.stringify([randomUUID(), 'synthetic-user', 'employee']);
    const b = await openTab();
    const a = await openTab();
    const [first, second] = [commandOf(), commandOf()];
    let answer = (_: ReturnType<typeof business>) => {};
    const executeA = vi.fn(() => new Promise<ReturnType<typeof business>>((resolve) => (answer = resolve)));
    const executeB = vi.fn(async () => business());
    const release = await holdLock(RECORDS);
    enter(a);
    const runA = a.app.runApplicationCommand(scope, first, executeA);
    enter(b);
    const runB = b.app.runApplicationCommand(scope, second, executeB);
    release();

    const error = await refusal(b, runB);
    expect(error.message).toBe(OTHER_TAB);
    expect(executeB).not.toHaveBeenCalled();
    expect(executeA).toHaveBeenCalledTimes(1);
    expect(recorded()).toEqual([first.commandId]);
    expect(b.app.readApplicationSession(scope)).toMatchObject({
      race: OTHER_TAB,
      error: '',
      pending: { commandId: first.commandId },
    });

    enter(a);
    const saved = business();
    answer(saved);
    await expect(runA).resolves.toMatchObject({ id: saved.id });
    expect(shared.getItem(RECORDS)).toBeNull();
    enter(b);
    storageEvent();
    // A 落定：B 的锁定与其他标签页提示一并消失，表单恢复可编辑（输入在抽屉的页面草稿里，未被清掉）。
    expect(b.app.readApplicationSession(scope)).toMatchObject({ race: '', pending: null, error: '' });
    await expect(b.app.runApplicationCommand(scope, commandOf(), executeB)).resolves.toMatchObject({
      status: 'in_review',
    });
    expect(executeB).toHaveBeenCalledTimes(1);
  });

  it('本页自己的未确认命令：再提交仍只提示处理中，不报其他标签页', async () => {
    const scope = JSON.stringify([randomUUID(), 'synthetic-user', 'employee']);
    const a = await openTab();
    const first = commandOf();
    await expect(a.app.runApplicationCommand(scope, first, offline)).rejects.toThrow(PROCESSING);
    const execute = vi.fn(async () => business());
    await expect(a.app.runApplicationCommand(scope, commandOf(), execute)).rejects.toThrow(PROCESSING);
    expect(execute).not.toHaveBeenCalled();
    const session = a.app.readApplicationSession(scope);
    expect(session).toMatchObject({ pending: { commandId: first.commandId } });
    expect((session as { race?: string }).race ?? '').toBe('');
  });

  it('正例：单标签正常提交成功，返回调动单、无锁定与提示', async () => {
    const scope = JSON.stringify([randomUUID(), 'synthetic-user', 'employee']);
    const a = await openTab();
    const saved = business();
    const execute = vi.fn(async () => saved);
    await expect(a.app.runApplicationCommand(scope, commandOf(), execute)).resolves.toEqual(saved);
    expect(execute).toHaveBeenCalledTimes(1);
    const session = a.app.readApplicationSession(scope);
    expect(session).toMatchObject({ saved, pending: null, error: '' });
    expect((session as { race?: string }).race ?? '').toBe('');
    expect(shared.getItem(RECORDS)).toBeNull();
  });
});
