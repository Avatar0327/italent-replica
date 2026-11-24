import { newCommand, type Command } from '../client.js';
import type { ResultVerdict } from './command-result.js';
import { messages } from './messages.js';
import { RecoveryConflict, type CommandRecovery, type PendingRecord } from './recovery.js';
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
  /** F-469：只有显式删除命令可走删除结果查询；随恢复槽保留。 */
  deletion?: boolean;
  /** F-110：从恢复记录载入（刷新前或别的标签页的命令），只有命令 ID 没有请求体：只能查询结果，不能原样重发。 */
  restored?: boolean;
  /** F-110：结果查询返回 404（不是确定结论），仍保持只读并提示稍后再查。 */
  resultPending?: boolean;
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
  /** F-469：只有显式删除命令可走删除结果查询；随恢复槽保留。 */
  deletion?: boolean;
  /** F-110：调用方已生成、已展示给用户的命令 ID（自助调动入口沿用）；缺省由内核生成。 */
  commandId?: string;
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
/** 槽里的命令未确认（处理中、结果未知、冲突）时返回它保存的上下文：同对象的其他动作据此禁用或按它重开。 */
export function lockedContext<C extends Values = Values>(state?: Submission) {
  return isLocked(state) ? (state!.context as C | undefined) : undefined;
}
/**
 * 恢复槽 → 占用它的条目（F-147）：批量命令、带版本的冲突恢复条目与槽不同名，按槽才能找到同对象的未确认命令。
 */
function createPins(notify: () => void, pins: Map<string, string>) {
  return {
    slotsOf: (key: string) => [...pins].filter(([, holder]) => holder === key).map(([slot]) => slot),
    holder: (slots: readonly string[]) => slots.map((slot) => pins.get(slot)).find((key) => key !== undefined),
    pin(slots: readonly string[], key: string) {
      slots.forEach((slot) => pins.set(slot, key));
      notify();
    },
    /** 只放开仍钉在 key 上的槽：别的命令后来钉上的不动。 */
    unpin(slots: readonly string[], key: string) {
      slots.forEach((slot) => {
        if (pins.get(slot) === key) pins.delete(slot);
      });
      notify();
    },
  };
}
/**
 * DEC-464/473/475：状态由页面持有；没有强制解锁未知命令或自动重放的接口。
 * 结果未知只能由用户显式按原命令重发（replay：同一命令 ID、请求体、版本；台账同键同内容回放第一次的结果，AGENTS §10）。
 */
export function createFormStore(options: { recovery?: CommandRecovery } = {}) {
  const core = createCore(options.recovery);
  const { entries, listeners, notify, pins, put, land, recover } = core;
  return {
    get: (key: string) => entries.get(key),
    ...pins,
    /** F-110：按共享恢复记录对齐别的标签页的未确认命令；提交前由内核与入口调用，storage 事件也会触发。 */
    sync: core.sync,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    clear(key: string) {
      if (isLocked(entries.get(key))) return;
      entries.delete(key);
      notify();
    },
    submit: (key: string, input: SubmitInput) => submitTo(core, key, input),
    /** 只对结果未知的命令：原样重发保存的命令，不重算请求体、不换 ID；其余状态原样返回。 */
    async replay(key: string, send: SubmitInput['send']) {
      const state = entries.get(key);
      if (state?.status !== 'unknown' || !state.command || state.reading || state.restored) return state;
      const running: Submission = { ...state, status: 'submitting', error: undefined, resultPending: undefined };
      put(key, running);
      land(key, running, await delivered(running, send));
      return entries.get(key)!;
    },
    async reread(key: string, read: (id?: string) => Promise<Latest>) {
      const state = entries.get(key);
      if (!state || state.reading || !['conflict', 'unknown'].includes(state.status)) return;
      put(key, { ...state, reading: true, readError: undefined });
      put(key, await rereadState(state, read));
    },
    recoverDeletion: (key: string, read: DeletionReader) =>
      recover(
        key,
        (state) => !!state.deletion && !!state.businessId,
        (state) => deletionOutcome(state, read),
      ),
    /** F-110：按原命令 ID 查询 F-120 结果（不重发命令）；read 负责查询与业务读回核对，查询失败不解锁。 */
    recoverResult: (key: string, read: ResultReader) =>
      recover(
        key,
        (state) => !state.deletion,
        async (state) => resultOutcome(await read(state.command!, state)),
      ),
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

/** 存储内部：条目、恢复槽、恢复记录与结果落地（迟到回执丢弃）。 */
function createCore(recovery?: CommandRecovery) {
  const entries = new Map<string, Submission>();
  const pinned = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const pins = createPins(notify, pinned);
  /**
   * F-110 第 2 轮 P2-2：恢复记录各标签页共用。载入别页（或刷新前）的未确认命令并锁定；
   * 别页已落定、记录已删的恢复条目放开。本页自己发出的命令和未锁定的槽不受影响；记录读不出时不动任何条目。
   */
  const sync = () => {
    const records = recovery?.load();
    if (!records) return;
    const adopted = records.filter(
      (record) => !isLocked(entries.get(record.key)) && entries.get(record.key)?.command?.id !== record.commandId,
    );
    adopted.forEach((record) => {
      entries.set(record.key, restoredState(record));
      record.slots
        .filter((slot) => !isLocked(entries.get(pinned.get(slot) ?? '')))
        .forEach((slot) => pinned.set(slot, record.key));
    });
    const settled = [...entries].filter(
      ([key, state]) =>
        state.restored &&
        state.status === 'unknown' &&
        !state.reading &&
        !records.some((record) => record.key === key && record.commandId === state.command?.id),
    );
    settled.forEach(([key]) => {
      entries.delete(key);
      [...pinned].filter(([, holder]) => holder === key).forEach(([slot]) => pinned.delete(slot));
    });
    if (adopted.length || settled.length) notify();
  };
  sync();
  recovery?.watch?.(sync);
  const put = (key: string, state: Submission) => {
    entries.set(key, state);
    notify();
  };
  /** 发送前先登记恢复记录（跨标签页互斥）；别页已占用、拿不到锁或写不进去就不发出（拒绝由调用方转成被拒）。 */
  const persist = async (key: string, state: Submission, slots: string[]) =>
    recovery?.save({
      key,
      slots,
      commandId: state.command!.id,
      revision: state.command!.revision,
      businessId: state.businessId,
      context: state.context,
      deletion: state.deletion,
    });
  /**
   * 回执 / 查询结果落地：条目已不是发出时的那个状态（迟到回执）一律丢弃，不覆盖后续命令（F-110 ②）；
   * 结果确定后删掉本命令的恢复记录。
   */
  const land = (key: string, from: Submission, next: Submission) => {
    if (entries.get(key) !== from) return undefined;
    put(key, next);
    // 删除在同一把跨标签页锁内异步执行，与各页登记按请求先后串行，不阻塞落地；失败不影响已落定的结果。
    if (next.command && !['submitting', 'unknown'].includes(next.status)) void recovery?.remove(key, next.command.id);
    return next;
  };
  const recover = async (
    key: string,
    eligible: (state: Submission) => boolean,
    compute: (state: Submission) => Promise<Partial<Submission>>,
  ) => {
    const state = entries.get(key);
    if (state?.status !== 'unknown' || !state.command || state.reading || !eligible(state)) return undefined;
    const reading = { ...state, reading: true, readError: undefined };
    put(key, reading);
    let next: Submission;
    try {
      next = { ...state, reading: false, readError: undefined, ...(await compute(state)) };
    } catch (readError) {
      next = { ...state, reading: false, readError };
    }
    // 迟到查询不能覆盖新状态；同一次查询期间 replay/reread 也会被 reading 挡住。
    return land(key, reading, next);
  };
  return { entries, listeners, notify, pins, put, persist, land, recover, sync };
}
type Core = ReturnType<typeof createCore>;

/** 首次提交：登记恢复记录后才发出；锁定中（含别的标签页未确认）原样返回。 */
async function submitTo(core: Core, key: string, input: SubmitInput) {
  // 槽在同步前取：同步可能把本条目的槽改钉到别页的命令上，登记时仍须按这些槽核对占用。
  const slots = core.pins.slotsOf(key);
  core.sync();
  const existing = core.entries.get(key);
  if (isLocked(existing)) return existing!;
  // 从恢复记录载入的条目没有草稿与基线：结果落定后按本次表单输入重新起算。
  const prior = existing?.status === 'done' || existing?.restored ? undefined : existing;
  const baseline = prior?.baseline ?? input.baseline;
  const revision = prior?.revision ?? input.revision;
  const body = commandBody(input, baseline);
  // 生效日期是调用方提供的租户业务日期，不从浏览器时区推算。
  if (input.effectiveDate !== undefined) body.effectiveDate = input.effectiveDate;
  const command = { ...newCommand(body, revision), ...(input.commandId ? { id: input.commandId } : {}) };
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
    deletion: input.deletion,
    latest: prior?.latest,
  };
  // 先置处理中再等锁：等锁期间本页同条目再提交被 isLocked 挡住，storage 同步也不接管处理中的条目。
  core.put(key, state);
  try {
    await core.persist(key, state, slots);
  } catch (error) {
    const other = error instanceof RecoveryConflict;
    const reason = other ? messages.otherTab : messages.recoveryUnavailable;
    core.land(key, state, { ...state, status: 'rejected', error: new Error(reason) });
    // 别页抢先登记了同一条目或槽：再同步一次，本页锁到那条命令上。
    if (other) core.sync();
    return core.entries.get(key)!;
  }
  core.land(key, state, await delivered(state, input.send));
  return core.entries.get(key)!;
}

type DeletionReader = (command: Command<Values>, id: string) => Promise<unknown>;
export type ResultReader = (command: Command<Values>, state: Submission) => Promise<ResultVerdict>;
/** F-469：查询权威结果，不重发命令；回执须匹配命令、对象、原版本，查询失败也不能解锁。 */
async function deletionOutcome(state: Submission, read: DeletionReader): Promise<Partial<Submission>> {
  const raw = await read(state.command!, state.businessId!);
  const result = raw as { commandId?: unknown; id?: unknown; revision?: unknown; status?: unknown } | null;
  if (
    result?.commandId !== state.command!.id ||
    result.id !== state.businessId ||
    result.revision !== state.command!.revision ||
    !['deleted', 'not_deleted', 'unknown'].includes(String(result.status))
  )
    throw new Error(messages.invalidReceipt);
  if (result.status === 'deleted') return { status: 'done' };
  if (result.status === 'not_deleted') return { status: 'rejected', error: new Error(messages.notDeleted) };
  return {};
}
/** 结果确定后解除锁定并清理恢复记录，失败或未执行保留本页原输入。 */
function resultOutcome(verdict: ResultVerdict): Partial<Submission> {
  if (verdict.status === 'succeeded')
    return {
      status: 'done',
      resultPending: undefined,
      ...(verdict.businessId ? { businessId: verdict.businessId } : {}),
    };
  if (verdict.status === 'failed')
    return { status: 'rejected', resultPending: undefined, error: new Error(messages.resultFailed) };
  if (verdict.status === 'not_executed')
    return { status: 'rejected', resultPending: undefined, error: new Error(messages.resultNotExecuted) };
  return { resultPending: true };
}
/** 从恢复记录载入的未确认命令（刷新前或别的标签页）：只有命令 ID 与上下文，没有请求体和草稿。 */
function restoredState(record: PendingRecord): Submission {
  return {
    status: 'unknown',
    values: {},
    baseline: {},
    editableFields: [],
    editedFields: [],
    revision: record.revision ?? 0,
    businessId: record.businessId,
    command: { id: record.commandId, revision: record.revision, body: {} },
    context: record.context,
    deletion: record.deletion,
    restored: true,
  };
}

/** 发出 state 里的命令，返回按回执落定的状态：首次提交与原命令重放共用同一判定。 */
async function delivered(state: Submission, send: SubmitInput['send']): Promise<Submission> {
  try {
    const result = await send(state.command!);
    if (typeof result?.id !== 'string' || !result.id || (state.businessId && result.id !== state.businessId))
      throw new Error(messages.unknown);
    return { ...state, status: 'done', businessId: result.id };
  } catch (error) {
    const status = failureStatus(error);
    return { ...state, error, status, ...(status === 'conflict' ? { latest: undefined } : {}) };
  }
}

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
