/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-FE-F571（F-566 卡外遗留）表单内核的本次拒绝提示标记（foundation/forms/refusal-marks）：审批、组织调整、HR 调动
 * 共用的口径，按 F-566 第 2 轮已核的几条逐条验证。用真实内核存储（createFormStore + sharedRecovery + 测试用 Web Locks），
 * 别的标签页 A 的登记用“持锁期间写入共用记录”模拟（同 AC-FE-F562 / AC-FE-F110-29），A 落定即删掉记录。
 * “渲染”用存储与标记各自的订阅回调代替：每次通知后排一个微任务按 marks.view 读一次当前条目（同 React 对外部存储
 * 更新的同步渲染排在微任务里），等同任一挂载实例这一次渲染出的状态。
 * 期望值手写。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdLock, installWebLocks } from './support/web-locks.js';

const uninstallLocks = installWebLocks();
const { createFormStore } = await import('../../apps/web/src/foundation/forms/store.js');
const { sharedRecovery } = await import('../../apps/web/src/foundation/forms/recovery.js');
const { createRefusalMarks, COMMAND_NOT_SENT } = await import('../../apps/web/src/foundation/forms/refusal-marks.js');
const { ApiError } = await import('../../apps/web/src/foundation/client.js');

const OTHER_TAB = '其他标签页有该对象未确认的命令，本次命令未发出；请等待结果或先查询结果。';
const LOCK_BUSY = '检测到你在另一个标签页打开了此单据，请关闭后重试。';
const LOCKS_UNSUPPORTED = '当前浏览器环境不支持安全保存（需 https 访问），命令未发出。';
const RESULT_FAILED = '已确认原命令未执行成功，输入已保留，请核对后重新提交。';
const LOCK_WAIT_MS = 3000;
type Submission = NonNullable<ReturnType<ReturnType<typeof createFormStore>['get']>>;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

function setup() {
  const name = `f571-${randomUUID()}`;
  const records = `italent.commands.pending:${name}`;
  const scoped = (path: string) => JSON.stringify(['synthetic-tenant', 'synthetic-user', path]);
  const slot = scoped('/api/tenant/synthetic/objects');
  const key = scoped('/api/tenant/synthetic/objects/synthetic-b');
  const keyA = scoped('/api/tenant/synthetic/objects/synthetic-a');
  const store = createFormStore({ recovery: sharedRecovery(name) });
  const marks = createRefusalMarks();
  const command = { peek: () => store.get(key), clear: () => store.clear(key) };
  const sent: { id: string; revision?: number }[] = [];
  /** 本页的输入：发出前调 issue（同各调用方），回执是同一对象（版本推进过 If-Match）。 */
  const submit =
    (respond: () => unknown = () => ({ id: 'synthetic-b' }), values = { subject: '合成主题（改）' }) =>
    (issue: () => void) =>
      store.submit(
        key,
        {
          values,
          baseline: { subject: '合成主题' },
          editableFields: ['subject'],
          revision: 4,
          businessId: 'synthetic-b',
          send: async (command) => {
            issue();
            sent.push({ id: command.id, revision: command.revision });
            return respond() as { id: string };
          },
        },
        [slot],
      );
  /** 两个挂载实例（详情与弹窗、关闭重开前后）：各自订阅存储与标记，每次通知时读一次显示状态。 */
  const mounts = [0, 1].map(() => {
    const seen: (Submission | undefined)[] = [];
    const render = () => queueMicrotask(() => seen.push(marks.view(store.get(key))));
    store.subscribe(render);
    marks.subscribe(render);
    return seen;
  });
  const registerA = () =>
    localStorage.setItem(records, JSON.stringify([{ key: keyA, slots: [slot], commandId: 'cmd-a', revision: 4 }]));
  /** B 等锁期间 A 登记；B 读到 A 的记录被拒之后、处理这次拒绝之前 A 已落定（删掉记录），内核不带 race / refused。 */
  async function raceWithLandedA<T>(run: () => Promise<T>) {
    const release = await holdLock(records);
    const request = navigator.locks.request.bind(navigator.locks);
    vi.spyOn(navigator.locks, 'request').mockImplementationOnce((...args: unknown[]) =>
      (request as (...rest: unknown[]) => Promise<unknown>)(...args).catch((cause: unknown) => {
        localStorage.removeItem(records);
        throw cause;
      }),
    );
    const pending = run();
    await Promise.resolve();
    registerA();
    release();
    return pending;
  }
  const showsRejected = (seen: (Submission | undefined)[], message: string) =>
    seen.some((state) => state?.status === 'rejected' && (state.error as Error | undefined)?.message === message);
  return {
    records,
    slot,
    key,
    keyA,
    store,
    marks,
    command,
    sent,
    submit,
    mounts,
    registerA,
    raceWithLandedA,
    showsRejected,
  };
}

describe('AC-FE-F571 内核标记：跨挂载共享、按同一次命令识别', () => {
  it('登记冲突且 A 已落定：两个挂载实例在处理中与处理后都不显示旧告警，条目留着、零请求', async () => {
    const t = setup();
    const outcome = await t.raceWithLandedA(() => t.marks.settle(t.command, t.submit())).catch((error) => ({ error }));
    // 未发出、不带 refused：settle 抛空值，弹窗不提示（同 F-566）。
    expect(outcome).toEqual({ error: undefined });
    expect(t.sent).toEqual([]);
    for (const seen of t.mounts) {
      expect(seen.length).toBeGreaterThan(1);
      expect(t.showsRejected(seen, OTHER_TAB)).toBe(false);
    }
    // 条目仍是这次被拒的命令（版本、基线、草稿留给下一次提交），只在显示上隐去。
    expect(t.store.get(t.key)).toMatchObject({
      status: 'rejected',
      revision: 4,
      values: { subject: '合成主题（改）' },
    });
    expect((t.store.get(t.key)!.error as Error).message).toBe(OTHER_TAB);
    expect(t.marks.view(t.store.get(t.key))).toMatchObject({ status: 'idle', error: undefined });
  });

  it('同一次命令的条目被内核复制（字段裁剪 settle）后仍隐去；重提换新命令，真正被拒照常显示', async () => {
    const t = setup();
    // 先走一次 409 冲突 → 重读 → 核对，条目带上最新记录（字段裁剪才有可回填的值）。
    const conflict = () => {
      throw new ApiError(409, 'REVISION_CONFLICT', 'conflict', '合成冲突');
    };
    await t.marks.settle(t.command, t.submit(conflict));
    await t.store.reread(t.key, async () => ({ id: 'synthetic-b', revision: 5, values: { subject: '合成主题' } }));
    t.store.confirm(t.key);
    await t.raceWithLandedA(() => t.marks.settle(t.command, t.submit())).catch(() => undefined);
    const stale = t.store.get(t.key)!;
    expect(stale).toMatchObject({ status: 'rejected', editedFields: ['subject'] });

    // 重开编辑时服务端裁剪了字段：内核复制条目（同一命令对象），隐去照旧。
    const copied = t.store.settle(t.key, []);
    expect(copied).toBeDefined();
    expect(t.store.get(t.key)).not.toBe(stale);
    expect(t.store.get(t.key)!.command).toBe(stale.command);
    expect(t.marks.view(t.store.get(t.key))).toMatchObject({ status: 'idle', error: undefined });

    // 再提交是新命令（If-Match 取已核对的 5），服务端明确拒绝：分类后照常显示。
    const invalid = () => {
      throw new ApiError(422, 'VALIDATION_FAILED', 'fields', '合成校验失败');
    };
    t.mounts.forEach((seen) => seen.splice(0));
    const rejected = await t.marks.settle(t.command, t.submit(invalid));
    expect(t.sent.map(({ revision }) => revision)).toEqual([4, 5]);
    expect(rejected.command!.id).not.toBe(stale.command!.id);
    expect(t.marks.view(t.store.get(t.key))).toMatchObject({ status: 'rejected' });
    for (const seen of t.mounts) expect(t.showsRejected(seen, '合成校验失败')).toBe(true);
  });

  it('新读回的记录版本更高时清掉过期条目；版本不高于条目时保留', async () => {
    const t = setup();
    await t.raceWithLandedA(() => t.marks.settle(t.command, t.submit())).catch(() => undefined);
    t.marks.supersede(t.command, 4);
    expect(t.store.get(t.key)).toMatchObject({ status: 'rejected' });
    t.marks.supersede(t.command, 5);
    expect(t.store.get(t.key)).toBeUndefined();
  });
});

describe('AC-FE-F571 内核标记：真正拒绝与查询确认失败仍展示', () => {
  it('等锁超时（DEC-954 refused）：抛出专门文案（COMMAND_NOT_SENT），条目照常显示、零请求', async () => {
    const t = setup();
    const release = await holdLock(t.records);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = t.marks.settle(t.command, t.submit()).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS);
      const error = (await pending) as InstanceType<typeof ApiError>;
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 409, code: COMMAND_NOT_SENT, message: LOCK_BUSY });
    } finally {
      release();
    }
    expect(t.sent).toEqual([]);
    expect(t.marks.view(t.store.get(t.key))).toMatchObject({ status: 'rejected' });
  });

  it('A 仍未确认：B 锁到 A；按原命令查询确认失败的条目不被隐去', async () => {
    const t = setup();
    t.registerA();
    t.store.sync();
    const outcome = await t.marks.settle(t.command, t.submit());
    expect(outcome.race).toEqual({ commandId: 'cmd-a', reason: OTHER_TAB });
    expect(t.store.holder([t.slot])).toBe(t.keyA);
    await t.store.recoverResult(t.keyA, async () => ({ status: 'failed', httpStatus: 422 }));
    const failed = t.store.get(t.keyA);
    expect(failed).toMatchObject({ status: 'rejected', command: { id: 'cmd-a' } });
    expect((failed!.error as Error).message).toBe(RESULT_FAILED);
    expect(t.marks.view(failed)).toBe(failed);
    expect(t.sent).toEqual([]);
  });
});

describe('AC-FE-F571 内核标记：attempt 入口（HR 调动）', () => {
  it('同步落下的未带命令拒绝（DEC-955）在处理函数跑完前隐去，处理后留在槽里的照常显示；settle 不隐去它', async () => {
    const t = setup();
    uninstallLocks();
    try {
      let during: Submission | undefined;
      let rendered: (Submission | undefined)[][] = [];
      const handled = await t.marks.attempt(t.command, t.submit(), (outcome, unsent) => {
        during = t.marks.view(t.command.peek());
        rendered = t.mounts.map((seen) => [...seen]);
        return { outcome, unsent };
      });
      expect(handled.unsent).toBe(true);
      expect(handled.outcome).toMatchObject({ status: 'rejected', refused: LOCKS_UNSUPPORTED });
      expect(t.store.get(t.key)!.command).toBeUndefined();
      expect(during).toMatchObject({ status: 'idle' });
      // 处理函数跑完前各挂载实例已渲染过（内核落下条目时的通知），都没读到这条拒绝。
      for (const seen of rendered) {
        expect(seen.length).toBeGreaterThan(0);
        expect(t.showsRejected(seen, LOCKS_UNSUPPORTED)).toBe(false);
      }
      await Promise.resolve();
      // 处理函数没有清槽：解除后照常显示（标记不留到下一次）。
      expect(t.marks.view(t.store.get(t.key))).toMatchObject({ status: 'rejected' });

      // settle（审批、组织调整）不隐去这条：原样显示并抛出 refused 文案（保持 F-566 原行为）。
      t.store.clear(t.key);
      t.mounts.forEach((seen) => seen.splice(0));
      const error = await t.marks.settle(t.command, t.submit()).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: COMMAND_NOT_SENT, message: LOCKS_UNSUPPORTED });
      await Promise.resolve();
      expect(t.showsRejected(t.mounts[0]!, LOCKS_UNSUPPORTED)).toBe(true);
    } finally {
      installWebLocks();
    }
    expect(t.sent).toEqual([]);
  });

  it('已发出被拒：处理函数里清槽之前各挂载实例都读不到被拒条目，处理函数的异常照常抛出', async () => {
    const t = setup();
    const invalid = () => {
      throw new ApiError(422, 'VALIDATION_FAILED', 'fields', '合成校验失败');
    };
    const error = await t.marks
      .attempt(t.command, t.submit(invalid), (outcome, unsent) => {
        expect(unsent).toBe(false);
        expect(t.marks.view(t.command.peek())).toMatchObject({ status: 'idle' });
        t.command.clear();
        throw outcome.error;
      })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 422, message: '合成校验失败' });
    expect(t.sent).toHaveLength(1);
    expect(t.store.get(t.key)).toBeUndefined();
    for (const seen of t.mounts) expect(t.showsRejected(seen, '合成校验失败')).toBe(false);
  });
});
