/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F110-17（F-110 第 3 轮返工 P2）两个标签页同时提交：登记恢复记录“读占用—检查—写入”须跨标签页原子互斥。
 * 读写屏障：A 读出恢复记录、尚未写回时，B 完整走一遍提交；再让 A 用读到的那份快照继续。
 * 同条目、同恢复槽竞争都只能发出一条命令且记录不丢；A 删除自己的记录时也不得覆盖 B 刚登记的记录。期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWebLocks } from './support/web-locks.js';

const RECORDS = 'italent.commands.pending:transfer';
const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';

/** 两页共用的本地存储；读恢复记录时可挂一次屏障：屏障跑完后仍返回屏障前读到的值（模拟读完、写回前被插队）。 */
class BarrierStorage {
  readonly #items = new Map<string, string>();
  barrier?: { when: () => boolean; run: () => void };
  get length() {
    return this.#items.size;
  }
  clear() {
    this.#items.clear();
  }
  getItem(key: string) {
    const value = this.#items.get(key) ?? null;
    const barrier = this.barrier;
    if (key === RECORDS && barrier?.when()) {
      this.barrier = undefined;
      barrier.run();
    }
    return value;
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
const shared = new BarrierStorage();
type Tab = Awaited<ReturnType<typeof openTab>>;
let current: Tab | undefined;
installWebLocks();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  shared.clear();
  shared.barrier = undefined;
});

function enter(tab: Tab) {
  current = tab;
  vi.stubGlobal('sessionStorage', tab.storage);
  vi.stubGlobal('localStorage', shared);
}
async function openTab() {
  const storage = new BarrierStorage();
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('localStorage', shared);
  vi.resetModules();
  const { transferCommands } = await import('../../apps/web/src/transfer/commands.js');
  const tab = { storage, commands: transferCommands };
  current = tab;
  return tab;
}
/** 每条命令发出即记下 ID，然后断网（结果未知，恢复记录保留）。 */
const sent: string[] = [];
const send = async (command: { id: string }): Promise<never> => {
  sent.push(command.id);
  throw new TypeError('合成断网');
};
const input = (commandId: string) => ({
  values: { place: '合成工作地' },
  baseline: { place: '原工作地' },
  editableFields: ['place'],
  revision: 3,
  commandId,
  send,
});
const scoped = (tenant: string, name: string) => JSON.stringify([tenant, 'synthetic-user', name]);
const recorded = () => (JSON.parse(shared.getItem(RECORDS) ?? '[]') as { commandId: string }[]).map((r) => r.commandId);

/** A 读出记录、写回前，B 在自己的页里提交 keyB；返回 B 那次提交的结果。 */
function interleave(a: Tab, b: Tab, keyA: string, keyB: string, idB: string) {
  let resultB: ReturnType<Tab['commands']['submit']> | undefined;
  shared.barrier = {
    when: () => current === a && a.commands.get(keyA)?.status === 'submitting',
    run() {
      enter(b);
      resultB = b.commands.submit(keyB, input(idB));
      enter(a);
    },
  };
  return () => {
    expect(resultB).toBeDefined();
    return resultB!;
  };
}

describe('AC-FE-F110-17 登记恢复记录跨标签页原子互斥', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('同一条目：A、B 同时提交，只发出 A 的命令，记录只有 A；B 不发出，返回其他标签页并锁在 A 的命令上', async () => {
    const key = scoped(randomUUID(), '/api/tenant/employment/transfers/employees/synthetic-e1');
    const [idA, idB] = ['synthetic-command-a', 'synthetic-command-b'];
    const b = await openTab();
    const a = await openTab();
    enter(a);
    const resultB = interleave(a, b, key, key, idB);
    const stateA = await a.commands.submit(key, input(idA));
    const stateB = await resultB();

    expect(sent).toEqual(['synthetic-command-a']);
    expect(recorded()).toEqual(['synthetic-command-a']);
    expect(stateA).toMatchObject({ status: 'unknown', command: { id: 'synthetic-command-a' } });
    // F-110 第 2 轮 P2-3：B 本次的结果是“其他标签页”拒绝，条目本身锁到 A 的恢复态上。
    expect(stateB.status).toBe('rejected');
    expect((stateB.error as Error).message).toBe(OTHER_TAB);
    expect(b.commands.get(key)).toMatchObject({
      status: 'unknown',
      restored: true,
      command: { id: 'synthetic-command-a' },
    });
  });

  it('钉在同一恢复槽的两个条目：A、B 同时提交，只发出 A 的命令；B 被拒（其他标签页），记录只有 A', async () => {
    const tenant = randomUUID();
    const slot = scoped(tenant, '/api/tenant/employment/transfers');
    const keyA = scoped(tenant, '/api/tenant/employment/transfers/employees/synthetic-e1');
    const keyB = scoped(tenant, '/api/tenant/employment/transfers/employees/synthetic-e2');
    const b = await openTab();
    const a = await openTab();
    enter(b);
    b.commands.pin([slot], keyB);
    enter(a);
    a.commands.pin([slot], keyA);
    const resultB = interleave(a, b, keyA, keyB, 'synthetic-command-b');
    await a.commands.submit(keyA, input('synthetic-command-a'));
    const stateB = await resultB();

    expect(sent).toEqual(['synthetic-command-a']);
    expect(recorded()).toEqual(['synthetic-command-a']);
    expect(stateB.status).toBe('rejected');
    expect((stateB.error as Error).message).toBe(OTHER_TAB);
  });

  it('删除也互斥：A 查到确定失败、删自己的记录时 B 登记另一员工，B 的记录不被覆盖', async () => {
    const tenant = randomUUID();
    const keyA = scoped(tenant, '/api/tenant/employment/transfers/employees/synthetic-e1');
    const keyB = scoped(tenant, '/api/tenant/employment/transfers/employees/synthetic-e2');
    const b = await openTab();
    const a = await openTab();
    enter(a);
    await a.commands.submit(keyA, input('synthetic-command-a'));
    expect(recorded()).toEqual(['synthetic-command-a']);

    let resultB: ReturnType<Tab['commands']['submit']> | undefined;
    shared.barrier = {
      when: () => current === a && a.commands.get(keyA)?.status === 'rejected',
      run() {
        enter(b);
        resultB = b.commands.submit(keyB, input('synthetic-command-b'));
        enter(a);
      },
    };
    await a.commands.recoverResult(keyA, async () => ({ status: 'failed', httpStatus: 422 }));
    await vi.waitFor(() => expect(resultB).toBeDefined());
    const stateB = await resultB!;

    expect(stateB).toMatchObject({ status: 'unknown', command: { id: 'synthetic-command-b' } });
    expect(sent).toEqual(['synthetic-command-a', 'synthetic-command-b']);
    await vi.waitFor(() => expect(recorded()).toEqual(['synthetic-command-b']));
  });
});
