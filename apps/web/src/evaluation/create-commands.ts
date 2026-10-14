import type { Command } from '../foundation/client.js';
import { createFormStore, type Values, type Submission } from '../foundation/forms/store.js';
import { m } from './messages.js';

/** 旧创建入口兼容层；错误分类与命令生命周期只由 F-123 内核负责。 */
export function createCommandStore() {
  const store = createFormStore();
  const cache = new WeakMap<Submission, { command: Command; object: string; summary: string; status: string }>();
  const objects = new Map<string, string>();
  return {
    subscribe: store.subscribe,
    get(key: string) {
      const state = store.get(key);
      if (!state || !['submitting', 'unknown'].includes(state.status)) return undefined;
      if (!cache.has(state))
        cache.set(state, {
          command: state.command!,
          object: objects.get(key)!,
          summary: String(state.values.name ?? state.values.personId ?? m.noValue),
          status: state.status === 'submitting' ? 'pending' : 'unknown',
        });
      return cache.get(state);
    },
    async run(key: string, object: string, body: unknown, send: (command: Command) => Promise<unknown>) {
      if (['submitting', 'unknown'].includes(store.get(key)?.status ?? '')) throw new Error(m.createUnknown);
      objects.set(key, object);
      const values = body as Values;
      const state = await store.submit(key, {
        values,
        baseline: {},
        editableFields: Object.keys(values),
        revision: 0,
        send: async (command) => (await send(command)) as { id: string },
      });
      if (state.status !== 'done') {
        store.clear(key);
        throw state.error;
      }
      store.clear(key);
    },
  };
}
