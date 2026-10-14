import { newCommand, type Command } from '../client.js';
import { messages } from './messages.js';
export type Values = Record<string, unknown>;
export interface Latest {
  id: string;
  revision: number;
  values: Values;
}
export interface Difference {
  field: string;
  before: unknown;
  latest: unknown;
  mine: unknown;
}
export interface Submission {
  status: 'idle' | 'submitting' | 'rejected' | 'unknown' | 'conflict' | 'done';
  values: Values;
  baseline: Values;
  editableFields: readonly string[];
  editedFields: readonly string[];
  revision: number;
  businessId?: string;
  command?: Command<Values>;
  error?: unknown;
  latest?: Latest;
  differences?: Difference[];
  reading?: boolean;
  readError?: unknown;
}
export interface SubmitInput {
  values: Values;
  baseline: Values;
  editableFields: readonly string[];
  revision: number;
  effectiveDate?: string;
  businessId?: string;
  patchOnly?: boolean;
  send(command: Command<Values>): Promise<{ id: string }>;
}
/**
 * 空值只有一种表示：undefined、null、空字符串、空数组都是“没有值”，互相等价（表单控件清空得 undefined / 空串 / 空数组，
 * 服务端记录里是 null）。0 与 false 是有效值，不算空。“改过的字段”、重读差异、回填判定都用这套比较，
 * 发送阶段不再做第二次转换（序列化只决定空值怎么写进请求，不改变哪些字段算改过）。
 */
const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
export const equal = (a: unknown, b: unknown) => (isEmpty(a) && isEmpty(b)) || JSON.stringify(a) === JSON.stringify(b);
export const isLocked = (state?: Submission) => !!state && ['submitting', 'unknown', 'conflict'].includes(state.status);
function failureStatus(error: unknown): Submission['status'] {
  const failure = error as { status?: number; code?: string } | null;
  if (typeof failure?.status !== 'number' || failure.status < 400 || failure.status >= 500) return 'unknown';
  if (failure.status === 409 && failure.code === 'REVISION_CONFLICT') return 'conflict';
  return 'rejected';
}
/** DEC-464/473/475：状态由页面持有；没有解锁未知命令或自动重放的接口。 */
export function createFormStore() {
  const entries = new Map<string, Submission>();
  const listeners = new Set<() => void>();
  const put = (key: string, state: Submission) => {
    entries.set(key, state);
    listeners.forEach((listener) => listener());
  };
  return {
    get: (key: string) => entries.get(key),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear(key: string) {
      if (isLocked(entries.get(key))) return;
      entries.delete(key);
      listeners.forEach((listener) => listener());
    },
    async submit(key: string, input: SubmitInput) {
      const existing = entries.get(key);
      if (isLocked(existing)) return existing!;
      const prior = existing?.status === 'done' ? undefined : existing;
      const baseline = prior?.baseline ?? input.baseline;
      const revision = prior?.revision ?? input.revision;
      const body = Object.fromEntries(
        Object.entries(input.values).filter(
          ([field, value]) =>
            input.editableFields.includes(field) && (!input.patchOnly || !equal(value, baseline[field])),
        ),
      );
      // 生效日期是调用方提供的租户业务日期，不从浏览器时区推算。
      if (input.effectiveDate !== undefined) body.effectiveDate = input.effectiveDate;
      const command = newCommand(body, revision);
      const state: Submission = {
        status: 'submitting',
        command,
        values: structuredClone(input.values),
        baseline: structuredClone(baseline),
        editableFields: [...input.editableFields],
        editedFields: input.editableFields.filter((field) => !equal(input.values[field], baseline[field])),
        revision,
        businessId: input.businessId,
        latest: prior?.latest,
      };
      put(key, state);
      try {
        const result = await input.send(command);
        if (typeof result?.id !== 'string' || !result.id || (input.businessId && result.id !== input.businessId))
          throw new Error(messages.unknown);
        put(key, { ...state, status: 'done', businessId: result.id });
      } catch (error) {
        const status = failureStatus(error);
        put(key, { ...state, error, status, ...(status === 'conflict' ? { latest: undefined } : {}) });
      }
      return entries.get(key)!;
    },
    async reread(key: string, read: (id?: string) => Promise<Latest>) {
      const state = entries.get(key);
      if (!state || state.reading || !['conflict', 'unknown'].includes(state.status)) return;
      put(key, { ...state, reading: true, readError: undefined });
      put(key, await rereadState(state, read));
    },
    confirm(key: string) {
      const state = entries.get(key);
      if (state?.status === 'conflict' && state.latest && !state.reading && !state.readError)
        put(key, {
          ...state,
          status: 'idle',
          baseline: state.latest.values,
          revision: state.latest.revision,
          error: undefined,
        });
    },
  };
}
export type FormStore = ReturnType<typeof createFormStore>;

async function rereadState(state: Submission, read: (id?: string) => Promise<Latest>): Promise<Submission> {
  try {
    const latest = structuredClone(await read(state.businessId));
    if (!latest.id || latest.id !== state.businessId || !Number.isSafeInteger(latest.revision) || latest.revision < 0)
      throw new Error(messages.invalidReceipt);
    const differences = state.editableFields
      .filter((field) => !equal(state.baseline[field], latest.values[field]))
      .map((field) => ({
        field,
        before: state.baseline[field],
        latest: latest.values[field],
        mine: state.editedFields.includes(field) ? state.values[field] : state.baseline[field],
      }));
    const values = { ...state.values };
    if (state.status === 'conflict')
      for (const field of state.editableFields) {
        // 重读产生的回填不是人工编辑；再次重读及服务端改回原值时也须跟随最新版本。
        if (!state.editedFields.includes(field)) values[field] = latest.values[field];
      }
    return { ...state, values, latest, differences, reading: false, readError: undefined };
  } catch (readError) {
    return { ...state, reading: false, readError };
  }
}
