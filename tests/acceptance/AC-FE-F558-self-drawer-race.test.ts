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
const LOCK_BUSY = '检测到你在另一个标签页打开了此单据，请关闭后重试。';

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
/** 回执由测试控制何时到达的执行函数（A 已发出、回执未到）。 */
function pendingExecute() {
  let answer = (_: ReturnType<typeof business>) => {};
  const execute = vi.fn(() => new Promise<ReturnType<typeof business>>((resolve) => (answer = resolve)));
  return { execute, answer: (value: ReturnType<typeof business>) => answer(value) };
}
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

// 第 2 轮 P2-1：登记阶段的普通拒绝（DEC-954 等锁超时）与登记竞争分开消费；普通拒绝留在本次操作的表单提示区，
// 竞争提示只随匹配的当前锁定命令显示，占槽命令已落定时不残留。
describe('AC-FE-F558-1 第 2 轮：普通拒绝与竞争分开', () => {
  it('B 等锁 3 秒超时、同步时接管了 A 的同作用域记录：等锁提示不丢，A 落定、B 回到表单后仍在', async () => {
    const scope = JSON.stringify([randomUUID(), 'synthetic-user', 'employee']);
    const b = await openTab();
    const a = await openTab();
    const first = commandOf();
    const holderA = pendingExecute();
    enter(a);
    const runA = a.app.runApplicationCommand(scope, first, holderA.execute);
    await vi.waitFor(() => expect(holderA.execute).toHaveBeenCalledTimes(1));
    const record = shared.getItem(RECORDS)!;
    // 跨标签页交错（浏览器里两页各自一个线程）：B 提交前同步读记录时，A 的登记还没落盘；B 排队等锁期间才写入。
    shared.removeItem(RECORDS);
    const release = await holdLock(RECORDS);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const executeB = vi.fn(async () => business());
    try {
      enter(b);
      const refused = refusal(b, b.app.runApplicationCommand(scope, commandOf(), executeB));
      shared.setItem(RECORDS, record);
      await vi.advanceTimersByTimeAsync(3000);
      const error = await refused;
      expect(error.notSent).toBe(true);
      expect(executeB).not.toHaveBeenCalled();
      // 落定时的同步接管了 A 的命令：锁到 A 上，但不是登记竞争，不带其他标签页提示；等锁提示仍是本次操作的结果。
      expect(b.app.readApplicationSession(scope)).toMatchObject({
        pending: { commandId: first.commandId },
        race: '',
        error: LOCK_BUSY,
      });
    } finally {
      vi.useRealTimers();
      release();
    }

    enter(a);
    const saved = business();
    holderA.answer(saved);
    await expect(runA).resolves.toEqual(saved);
    await vi.waitFor(() => expect(shared.getItem(RECORDS)).toBeNull());
    enter(b);
    storageEvent();
    expect(b.app.readApplicationSession(scope)).toMatchObject({ pending: null, race: '', error: LOCK_BUSY });
    expect(executeB).not.toHaveBeenCalled();
  });

  it('B 登记冲突、处理拒绝前 A 已落定（内核不带竞争）：不残留其他标签页提示，B 表单可再提交', async () => {
    const scope = JSON.stringify([randomUUID(), 'synthetic-user', 'employee']);
    const b = await openTab();
    const a = await openTab();
    const saved = business();
    const executeA = vi.fn(async () => saved);
    const executeB = vi.fn(async () => business());
    const release = await holdLock(RECORDS);
    enter(a);
    const runA = a.app.runApplicationCommand(scope, commandOf(), executeA);
    // 跨标签页交错：B 的登记读到 A 的记录被拒之后、B 处理这次拒绝之前，A 已收到回执并删掉记录（A 的删除排在 B 之后）。
    const request = navigator.locks.request.bind(navigator.locks);
    const spy = vi.spyOn(navigator.locks, 'request').mockImplementationOnce((...args: unknown[]) =>
      (request as (...rest: unknown[]) => Promise<unknown>)(...args).catch(async (cause: unknown) => {
        await vi.waitFor(() => expect(shared.getItem(RECORDS)).toBeNull());
        throw cause;
      }),
    );
    enter(b);
    const runB = refusal(b, b.app.runApplicationCommand(scope, commandOf(), executeB));
    spy.mockRestore();
    release();
    await expect(runA).resolves.toEqual(saved);
    const error = await runB;
    expect(error.notSent).toBe(true);
    expect(executeB).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(shared.getItem(RECORDS)).toBeNull());
    enter(b);
    storageEvent();
    // 占槽的 A 已落定、记录已删：B 没有锁定的命令，其他标签页提示不能留在表单上。
    expect(b.app.readApplicationSession(scope)).toMatchObject({ pending: null, race: '', error: '' });
    await expect(b.app.runApplicationCommand(scope, commandOf(), executeB)).resolves.toMatchObject({
      status: 'in_review',
    });
    expect(executeB).toHaveBeenCalledTimes(1);
  });
});

// 第 2 轮 P2-2：查询期间 reading 挡住了 storage 同步；查询结束后须按记录再同步一次，否则一直锁在已落定的别页命令上。
describe('AC-FE-F558-1 第 2 轮：回查期间错过别页落定通知', () => {
  it('B 锁到 A 的命令后按原 ID 查询：A 成功删记录的通知先到、404 后到，B 查询结束即解锁；本页自己的未知命令仍锁定', async () => {
    const tenant = randomUUID();
    const scope = JSON.stringify([tenant, 'synthetic-user', 'employee']);
    const own = JSON.stringify([tenant, 'synthetic-user', 'manager']);
    const b = await openTab();
    const a = await openTab();
    const first = commandOf();
    const holderA = pendingExecute();
    enter(a);
    const runA = a.app.runApplicationCommand(scope, first, holderA.execute);
    await vi.waitFor(() => expect(holderA.execute).toHaveBeenCalledTimes(1));

    enter(b);
    const mine = commandOf();
    await expect(b.app.runApplicationCommand(own, mine, offline)).rejects.toThrow(PROCESSING);
    const executeB = vi.fn(async () => business());
    await refusal(b, b.app.runApplicationCommand(scope, commandOf(), executeB));
    expect(b.app.readApplicationSession(scope)).toMatchObject({
      race: OTHER_TAB,
      pending: { commandId: first.commandId },
    });
    let notFound = () => {};
    const fetch = vi.fn((path: string) =>
      path === `/api/tenant/commands/${first.commandId}/result`
        ? new Promise<Response>(
            (resolve) => (notFound = () => resolve(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }))),
          )
        : Promise.resolve(Response.json({}, { status: 500 })),
    );
    vi.stubGlobal('fetch', fetch);
    const query = b.app.queryApplicationResult(scope, tenant);
    expect(b.app.readApplicationSession(scope).reading).toBe(true);

    enter(a);
    holderA.answer(business());
    await runA;
    await vi.waitFor(() => expect(recorded()).toEqual([mine.commandId]));
    enter(b);
    storageEvent(); // 删除通知先到：B 正在查询，这次同步被挡住
    notFound(); // 此前发出的 GET 后到：查不到
    await query;

    expect(b.app.readApplicationSession(scope)).toMatchObject({ pending: null, race: '', reading: false });
    // 本页自己的结果未知命令不受这次同步影响：仍锁定待确认，记录仍在。
    expect(b.app.readApplicationSession(own)).toMatchObject({
      restored: false,
      pending: { commandId: mine.commandId },
    });
    expect(recorded()).toEqual([mine.commandId]);
    // B 全程只有一次结果查询（GET），没有写请求。
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([`/api/tenant/commands/${first.commandId}/result`]);
    expect(executeB).not.toHaveBeenCalled();
  });
});
