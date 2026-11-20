/// <reference lib="dom" />
/**
 * F-110 第 3 轮：测试用的 Web Locks（navigator.locks）。同名锁独占、按请求先后授予，与浏览器同源各标签页共用一套锁的口径一致；
 * 测试里各“标签页”共用同一个全局，装一份即覆盖所有页。happy-dom 的 navigator.locks 为 null，Node 22 / 24 也不一致，
 * 凡经 sharedRecovery 登记命令（审批、调动）的测试统一在文件顶层装这份；不装时内核按“拿不到锁不发出”拒绝提交。
 */
type LockCallback = (lock: { name: string; mode: 'exclusive' }) => unknown;

export function installWebLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const locks = {
    request(name: string, ...rest: unknown[]) {
      const callback = rest.at(-1) as LockCallback;
      const granted = (tails.get(name) ?? Promise.resolve()).then(() => callback({ name, mode: 'exclusive' }));
      tails.set(
        name,
        granted.then(
          () => undefined,
          () => undefined,
        ),
      );
      return granted;
    },
  };
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
  return () => {
    delete (globalThis.navigator as { locks?: unknown }).locks;
  };
}
