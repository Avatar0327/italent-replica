/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F110-15（F-110 第 2 轮返工 P2-2）同租户、同用户的两个标签页：相关恢复槽跨标签页协调占用，发送前确认。
 * 每个标签页各一份模块实例（vi.resetModules 后重新导入）和一份 sessionStorage；localStorage 两页共用（同源浏览器口径）。
 * 只用既有导出（transferCommands、runApplicationCommand 等），基线上按行为变红；期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWebLocks } from './support/web-locks.js';

// F-110 第 3 轮：调动 / 审批命令登记恢复记录须拿跨标签页锁，测试环境装一份 Web Locks。
installWebLocks();

/** 最小 Web Storage：每个标签页一份会话存储，两页共用一份本地存储。 */
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
type Tab = Awaited<ReturnType<typeof openTab>>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  shared.clear();
});

/** 切到某个标签页：之后的存储读写落到它的会话存储与共用的本地存储。 */
function enter(tab: { storage: MemoryStorage }) {
  vi.stubGlobal('sessionStorage', tab.storage);
  vi.stubGlobal('localStorage', shared);
}
/** 新开一个标签页：新的会话存储 + 新的模块实例（模块级命令存储在这一页里初始化）。 */
async function openTab() {
  const tab = { storage: new MemoryStorage() };
  enter(tab);
  vi.resetModules();
  const { transferCommands } = await import('../../apps/web/src/transfer/commands.js');
  const app = await import('../../apps/web/src/self-service/pages/application-session.js');
  return { ...tab, commands: transferCommands, app };
}
const offline = async (): Promise<never> => {
  throw new TypeError('合成断网');
};
const input = (send: (command: unknown) => Promise<{ id: string }>) => ({
  values: { place: '合成工作地' },
  baseline: { place: '原工作地' },
  editableFields: ['place'],
  revision: 3,
  send,
});
const scoped = (tenant: string, name: string) => JSON.stringify([tenant, 'synthetic-user', name]);
const storageEvent = () => window.dispatchEvent(new StorageEvent('storage', { key: RECORDS }));

/** A 发出一条结果未知的命令（回执丢失），返回它的命令 ID。 */
async function unknownIn(a: Tab, key: string) {
  enter(a);
  const state = await a.commands.submit(key, input(offline));
  expect(state.status).toBe('unknown');
  return state.command!.id;
}
/** A 按原命令 ID 查到确定失败（F-120 failed）：A 放开锁，恢复记录删掉。 */
async function failIn(a: Tab, key: string) {
  enter(a);
  await a.commands.recoverResult(key, async () => ({ status: 'failed', httpStatus: 422 }));
  expect(a.commands.get(key)?.status).toBe('rejected');
  expect(shared.getItem(RECORDS)).toBeNull();
}

describe('AC-FE-F110-15 两个标签页协调恢复槽', () => {
  it('同一对象：A 结果未知期间 B 不发出新 ID 的同内容命令，锁在 A 的命令上；A 查到确定结论后 B 才放行', async () => {
    const key = scoped(randomUUID(), '/api/tenant/employment/transfers/employees/synthetic-e1');
    const b = await openTab(); // B 在 A 提交前就已打开：初始化时没有任何记录。
    const a = await openTab();
    const pending = await unknownIn(a, key);

    enter(b);
    const send = vi.fn(async () => ({ id: 'synthetic-business' }));
    const blocked = await b.commands.submit(key, { ...input(send), commandId: randomUUID() });
    expect(send).not.toHaveBeenCalled();
    expect(blocked).toMatchObject({ status: 'unknown', restored: true, command: { id: pending } });

    await failIn(a, key);
    enter(b);
    const next = randomUUID();
    const released = await b.commands.submit(key, { ...input(send), commandId: next });
    expect(send).toHaveBeenCalledTimes(1);
    expect(released).toMatchObject({ status: 'done', command: { id: next } });
  });

  it('钉在同一恢复槽的另一条目（调动集合槽、另一员工）：A 未确认期间 B 的命令不发出，槽仍归 A 的命令', async () => {
    const tenant = randomUUID();
    const slot = scoped(tenant, '/api/tenant/employment/transfers');
    const keyA = scoped(tenant, '/api/tenant/employment/transfers/employees/synthetic-e1');
    const keyB = scoped(tenant, '/api/tenant/employment/transfers/employees/synthetic-e2');
    const b = await openTab();
    const a = await openTab();
    enter(a);
    a.commands.pin([slot], keyA);
    const pending = await unknownIn(a, keyA);

    enter(b);
    b.commands.pin([slot], keyB);
    const send = vi.fn(async () => ({ id: 'synthetic-business' }));
    const state = await b.commands.submit(keyB, { ...input(send), commandId: randomUUID() });
    expect(send).not.toHaveBeenCalled();
    expect(state.status).toBe('rejected');
    expect((state.error as Error).message).toBe(OTHER_TAB);
    expect(b.commands.holder([slot])).toBe(keyA);
    expect(b.commands.get(keyA)).toMatchObject({ status: 'unknown', restored: true, command: { id: pending } });
  });

  it('B 已打开的页面收到 storage 事件即锁定到 A 的命令（不等提交）；A 落定后再收到事件即解锁', async () => {
    const key = scoped(randomUUID(), '/api/tenant/employment/transfers/employees/synthetic-e1');
    const b = await openTab();
    const a = await openTab();
    const pending = await unknownIn(a, key);
    enter(b);
    storageEvent();
    expect(b.commands.get(key)).toMatchObject({ status: 'unknown', restored: true, command: { id: pending } });

    await failIn(a, key);
    enter(b);
    storageEvent();
    expect(b.commands.get(key)).toBeUndefined();
  });

  it('自助 / 经理调动抽屉：A 结果未知期间 B 换新 ID 发起被挡、不执行；A 查到确定失败后 B 才执行', async () => {
    const tenant = randomUUID();
    const scope = scoped(tenant, 'manager');
    const command = {
      commandId: randomUUID(),
      employeeId: 'synthetic-employee',
      action: 'submit' as const,
      effectiveDate: '2026-11-02',
      summary: {},
    };
    const business = { id: randomUUID(), revision: 1, employeeRevision: 7, status: 'in_review' };
    const b = await openTab();
    const a = await openTab();
    enter(a);
    await expect(a.app.runApplicationCommand(scope, command, offline)).rejects.toThrow(PROCESSING);

    enter(b);
    const execute = vi.fn(async () => business);
    await expect(b.app.runApplicationCommand(scope, { ...command, commandId: randomUUID() }, execute)).rejects.toThrow(
      PROCESSING,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(b.app.readApplicationSession(scope)).toMatchObject({
      restored: true,
      pending: { commandId: command.commandId, employeeId: 'synthetic-employee' },
    });

    enter(a);
    // F-120 自助调动命令确定失败的真实形状：摘要三项为 null（command-result/service.ts）。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) =>
        path === `/api/tenant/commands/${command.commandId}/result`
          ? Response.json({
              commandId: command.commandId,
              status: 'failed',
              commandType: 'POST /api/tenant/self-service/transfer',
              businessType: null,
              businessId: null,
              revision: null,
              httpStatus: 422,
              completedAt: '2026-11-20T01:02:03.000Z',
            })
          : Response.json({}, { status: 500 }),
      ),
    );
    await a.app.queryApplicationResult(scope, tenant);
    expect(a.app.readApplicationSession(scope).pending).toBeNull();
    expect(shared.getItem(RECORDS)).toBeNull();

    enter(b);
    const next = { ...command, commandId: randomUUID() };
    await expect(b.app.runApplicationCommand(scope, next, execute)).resolves.toMatchObject({ id: business.id });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
