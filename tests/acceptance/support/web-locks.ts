/// <reference lib="dom" />
/**
 * F-110 第 3 轮：测试用的 Web Locks（navigator.locks）。同名锁独占、按请求先后授予，与浏览器同源各标签页共用一套锁的口径一致；
 * 测试里各“标签页”共用同一个全局，装一份即覆盖所有页。happy-dom 的 navigator.locks 为 null，Node 22 / 24 也不一致，
 * 凡经 sharedRecovery 登记命令（审批、调动）的测试统一在文件顶层装这份；不装时内核按“不支持锁”拒绝提交（DEC-955）。
 * DEC-954：支持 options.signal，等锁期间中止即以 AbortError 拒绝、不再执行回调，与浏览器一致；已授予后中止不影响。
 */
type LockCallback = (lock: { name: string; mode: 'exclusive' }) => unknown;

const abortError = () => new DOMException('lock request aborted', 'AbortError');

export function installWebLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const locks = {
    request(name: string, ...rest: unknown[]) {
      const callback = rest.at(-1) as LockCallback;
      const signal = rest.length > 1 ? (rest[0] as { signal?: AbortSignal }).signal : undefined;
      if (signal?.aborted) return Promise.reject(abortError());
      let started = false;
      const granted = (tails.get(name) ?? Promise.resolve()).then(() => {
        if (signal?.aborted) throw abortError();
        started = true;
        return callback({ name, mode: 'exclusive' });
      });
      tails.set(
        name,
        granted.then(
          () => undefined,
          () => undefined,
        ),
      );
      if (!signal) return granted;
      const aborted = new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => !started && reject(abortError()), { once: true }),
      );
      return Promise.race([granted, aborted]);
    },
  };
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
  return () => {
    delete (globalThis.navigator as { locks?: unknown }).locks;
  };
}

/** 模拟别的标签页一直占着同名锁；返回释放函数（相当于关闭那个页面）。 */
export async function holdLock(name: string) {
  let release = () => {};
  await new Promise<void>((held) => {
    void navigator.locks.request(name, { mode: 'exclusive' }, () => {
      held();
      return new Promise<void>((resolve) => (release = resolve));
    });
  });
  return () => release();
}
