/**
 * 审批实例请求通道（DEC-277 ①）：同一实例的详情 GET、历史分页 GET、恢复回查与全部写 POST 串行执行，
 * 同一时刻只有一个在途，后发的排队。通道重置（收紧信号、清理、卸载）丢弃排队中的请求、中止在途请求并
 * 提升版本号；带旧版本号的迟到响应一律作为 STALE 丢弃，不进入页面状态。
 */
export const STALE: unique symbol = Symbol('stale');
export type Stale = typeof STALE;
export interface RequestLane {
  /** 排队执行；通道重置后以 STALE 结束，只有当前版本的失败才会抛出。 */
  run<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T | Stale>;
  /** 丢弃排队中的请求、中止在途请求，并作废其响应。 */
  reset(): void;
}
interface Entry {
  readonly version: number;
  readonly start: (signal: AbortSignal) => Promise<unknown>;
  readonly settle: (value: unknown) => void;
  readonly fail: (error: unknown) => void;
}
export function createRequestLane(): RequestLane {
  let version = 0;
  let busy = false;
  let controller: AbortController | undefined;
  const queue: Entry[] = [];
  function next() {
    if (busy) return;
    const entry = queue.shift();
    if (!entry) return;
    if (entry.version !== version) {
      entry.settle(STALE);
      next();
      return;
    }
    busy = true;
    controller = new AbortController();
    const finish = (value: unknown, ok: boolean) => {
      busy = false;
      if (entry.version !== version) entry.settle(STALE);
      else if (ok) entry.settle(value);
      else entry.fail(value);
      next();
    };
    void entry.start(controller.signal).then(
      (value) => finish(value, true),
      (error: unknown) => finish(error, false),
    );
  }
  return {
    run: <T>(job: (signal: AbortSignal) => Promise<T>) =>
      new Promise<T | Stale>((settle, fail) => {
        queue.push({ version, start: job, settle: settle as (value: unknown) => void, fail });
        next();
      }),
    reset() {
      version++;
      controller?.abort();
      for (const entry of queue.splice(0)) entry.settle(STALE);
    },
  };
}
