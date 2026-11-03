// F-123 持有整次提交及锁；这里只保留尚无确定回执的原传输，不另建表单状态机。
const pending = new Map<string, { retry(): Promise<void>; busy: boolean }>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
export const replayChanges = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const pendingReplay = (key: string) => pending.get(key);
export function recoverSelfRequest<T>(key: string, send: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const attempt = async (replay = false) => {
      try {
        const result = await send();
        pending.delete(key);
        notify();
        resolve(result);
      } catch (error) {
        const status = (error as { status?: number })?.status;
        // 确定的 409 交还 F-123 重读/核对；原重放槽不能覆盖 conflict 状态。
        if (status === 409 || (!replay && status && status >= 400 && status < 500)) {
          pending.delete(key);
          notify();
          return reject(error);
        }
        pending.set(key, { busy: false, retry: () => attempt(true) });
        notify();
      }
    };
    void attempt();
  });
}
export async function replaySelfRequest(key: string, read: () => Promise<unknown>) {
  const item = pending.get(key);
  if (!item || item.busy) return;
  pending.set(key, { ...item, busy: true });
  notify();
  try {
    await read();
    await item.retry();
  } finally {
    const next = pending.get(key);
    if (next) pending.set(key, { ...next, busy: false });
    notify();
  }
}
