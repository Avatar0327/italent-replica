import { newCommand, type Command } from '../client.js';
import { messages } from './messages.js';
import { changedFields, refillDraft, sameValue, type Values } from './values.js';
export type { Values } from './values.js';
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
  /** 命令上下文（业务时点、动作等）：不进请求体，随槽保存，换日期 / 动作 / 入口重开时以它为准。 */
  context?: Values;
}
export interface SubmitInput {
  values: Values;
  baseline: Values;
  editableFields: readonly string[];
  revision: number;
  effectiveDate?: string;
  businessId?: string;
  patchOnly?: boolean;
  context?: Values;
  send(command: Command<Values>): Promise<{ id: string }>;
}
/** F-141 起对外的比较名；实现只有 values.ts 的 sameValue 一份（DEC-502②），空值口径相同：0 与 false 不算空。 */
export const equal = sameValue;
export const isLocked = (state?: Submission) => !!state && ['submitting', 'unknown', 'conflict'].includes(state.status);
function failureStatus(error: unknown): Submission['status'] {
  const failure = error as { status?: number; code?: string } | null;
  if (typeof failure?.status !== 'number' || failure.status < 400 || failure.status >= 500) return 'unknown';
  if (failure.status === 409 && failure.code === 'REVISION_CONFLICT') return 'conflict';
  return 'rejected';
}
/** 槽里还有未完成的命令（处理中、结果未知、冲突、被拒）时返回它保存的上下文；完成或空槽返回 undefined。 */
export function slotContext<C extends Values = Values>(state?: Submission) {
  return state && state.status !== 'done' ? (state.context as C | undefined) : undefined;
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
      const body = commandBody(input, baseline);
      // 生效日期是调用方提供的租户业务日期，不从浏览器时区推算。
      if (input.effectiveDate !== undefined) body.effectiveDate = input.effectiveDate;
      const command = newCommand(body, revision);
      const state: Submission = {
        status: 'submitting',
        command,
        values: structuredClone(input.values),
        baseline: structuredClone(baseline),
        editableFields: [...input.editableFields],
        editedFields: changedFields(input.values, baseline, input.editableFields),
        revision,
        businessId: input.businessId,
        // 未完成的命令沿用它当初的上下文，与基线、版本同理。
        context: prior?.context ?? input.context,
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
    /** 当前不可提交的已改字段改取最新记录（见 settledState）；有改动时返回改后的状态，没有改动返回 undefined。 */
    settle(key: string, submittable: readonly string[]) {
      const state = entries.get(key);
      const next = state && settledState(state, submittable);
      if (next) put(key, next);
      return next;
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

/** 请求体只带可编辑字段；patchOnly 时再去掉与基线相同的字段（空值统一口径）。 */
function commandBody(input: SubmitInput, baseline: Values) {
  return Object.fromEntries(
    Object.entries(input.values).filter(
      ([field, value]) =>
        input.editableFields.includes(field) && (!input.patchOnly || !sameValue(value, baseline[field])),
    ),
  );
}

async function rereadState(state: Submission, read: (id?: string) => Promise<Latest>): Promise<Submission> {
  try {
    const latest = structuredClone(await read(state.businessId));
    if (!latest.id || latest.id !== state.businessId || !Number.isSafeInteger(latest.revision) || latest.revision < 0)
      throw new Error(messages.invalidReceipt);
    const differences = state.editableFields
      .filter((field) => !sameValue(state.baseline[field], latest.values[field]))
      .map((field) => ({
        field,
        before: state.baseline[field],
        latest: latest.values[field],
        mine: state.editedFields.includes(field) ? state.values[field] : state.baseline[field],
      }));
    // 重读产生的回填不是人工编辑；再次重读及服务端改回原值时也须跟随最新版本。上次不可提交的字段同样取最新。
    const unedited = state.editableFields.filter((field) => !state.editedFields.includes(field));
    const values =
      state.status === 'conflict'
        ? refillDraft({
            // 最新记录里没有的未改字段同样跟随最新（置空）。
            values: { ...state.values, ...Object.fromEntries(unedited.map((field) => [field, undefined])) },
            latest: latest.values,
            edited: state.editedFields,
            submittable: state.editableFields,
          })
        : state.values;
    return { ...state, values, latest, differences, reading: false, readError: undefined };
  } catch (readError) {
    return { ...state, reading: false, readError };
  }
}

/**
 * 当前不可提交的已改字段以最新记录为准、改记为未改（claude_fe_rules b）：只读回填不只改表单控件，
 * 也改内核草稿。之后不重提再重读、字段恢复可编辑时，旧草稿都不会复活。处理中、结果未知的命令不动。
 */
function settledState(state: Submission, submittable: readonly string[]): Submission | undefined {
  if (!state.latest || ['submitting', 'unknown', 'done'].includes(state.status)) return undefined;
  const fixed = state.editedFields.filter((field) => !submittable.includes(field));
  if (!fixed.length) return undefined;
  const latest = state.latest.values;
  return {
    ...state,
    values: { ...state.values, ...Object.fromEntries(fixed.map((field) => [field, latest[field]])) },
    editedFields: state.editedFields.filter((field) => submittable.includes(field)),
  };
}
