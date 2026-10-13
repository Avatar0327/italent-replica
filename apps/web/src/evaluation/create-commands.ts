import { ApiError, newCommand, type Command } from '../foundation/client.js';
import { m } from './messages.js';

export interface PendingCreate {
  command: Command;
  object: string;
  summary: string;
  status: 'pending' | 'unknown';
}
/** DEC-464：页面持有未确认命令；只展示回执状态，不恢复或重发在途表单。 */
export function createCommandStore() {
  const entries = new Map<string, PendingCreate>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    get: (key: string) => entries.get(key),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async run(key: string, object: string, body: unknown, send: (command: Command) => Promise<unknown>) {
      if (entries.has(key)) throw new Error(m.createUnknown);
      const command = newCommand(body, 0);
      const values = body as Record<string, unknown>;
      const entry: PendingCreate = {
        command,
        object,
        status: 'pending',
        summary: String(values.name ?? values.personId ?? m.noValue),
      };
      entries.set(key, entry);
      notify();
      try {
        await send(command);
        entries.delete(key);
      } catch (error) {
        // 明确拒绝可修正后重提；网络、5xx、无有效回执及身份切换中断都不能判作未创建。
        if (error instanceof ApiError && error.kind !== 'unknown') entries.delete(key);
        else entries.set(key, { ...entry, status: 'unknown' });
        throw error;
      } finally {
        notify();
      }
    },
  };
}
