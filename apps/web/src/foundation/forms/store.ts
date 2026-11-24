import { newCommand, type Command } from '../client.js';
import type { ResultVerdict } from './command-result.js';
import { messages } from './messages.js';
import {
  RecoveryConflict,
  RecoveryLockBusy,
  RecoveryLocksUnsupported,
  type CommandRecovery,
  type PendingRecord,
} from './recovery.js';
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
/**
 * F-110 第 4 轮：本次提交没有发出、锁到了别的标签页（或刷新前）的未确认命令上。只随提交结果带出，不存进条目；
 * “提交前同步就发现已被占用”和“登记时冲突”两条路径都由 raceOf 这一处生成（单一出口）。
 */
export interface Race {
  reason: string;
  /** 占着恢复槽的命令 ID：页面只在当前锁定的正是这条命令时显示原因。 */
  commandId: string;
}
export type Outcome = Submission & { race?: Race };
/** F-141 起对外的比较名；实现只有 values.ts 的 sameValue 一份（DEC-502②），空值口径相同：0 与 false 不算空。 */
export const equal = sameValue;
export const isLocked = (state?: Submission) => !!state && ['submitting', 'unknown', 'conflict'].includes(state.status);
/** 未确认（处理中、结果未知）：恢复槽只交给这样的命令；冲突、被拒、完成都是已确认的结果。 */
const unconfirmed = (state?: Submission) => !!state && ['submitting', 'unknown'].includes(state.status);
/** 竞争的唯一来源：条目是从共用恢复记录载入、仍锁定的命令（只有命令 ID，本页没有发出过它）。 */
const raceOf = (state?: Submission): Race | undefined =>
  state?.restored && isLocked(state) && state.command
    ? { reason: messages.otherTab, commandId: state.command.id }
    : undefined;
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
 * 对外只能钉（提交中把替换 ID 等也钉到本命令）；放开与交接只在内核里（release / align，F-110 第 4 轮）。
 */
function createPins(notify: () => void, pins: Map<string, string>) {
  return {
    slotsOf: (key: string) => [...pins].filter(([, holder]) => holder === key).map(([slot]) => slot),
    holder: (slots: readonly string[]) => slots.map((slot) => pins.get(slot)).find((key) => key !== undefined),
    pin(slots: readonly string[], key: string) {
      slots.forEach((slot) => pins.set(slot, key));
      notify();
    },
  };
}
/**
 * DEC-464/473/475：状态由页面持有；没有强制解锁未知命令或自动重放的接口。
 * 结果未知只能由用户显式按原命令重发（replay：同一命令 ID、请求体、版本；台账同键同内容回放第一次的结果，AGENTS §10）。
 */
export function createFormStore(options: { recovery?: CommandRecovery; precheck?: () => Error | undefined } = {}) {
  const core = createCore(options.recovery, options.precheck ?? options.recovery?.precheck);
  const { entries, listeners, notify, pins, put, land, recover } = core;
  return {
    get: (key: string) => entries.get(key),
    ...pins,
    /** F-110：按共享恢复记录对齐别的标签页的未确认命令；提交前由内核与入口调用，storage 事件也会触发。 */
    sync: () => core.sync(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    clear(key: string) {
      if (isLocked(entries.get(key))) return;
      entries.delete(key);
      notify();
    },
    /** claim：本命令涉及的恢复槽（页面声明）；内核核对占用、登记并钉住，结果确定后放开。 */
    submit: (key: string, input: SubmitInput, claim: readonly string[] = []) => submitTo(core, key, input, claim),
    /** 生成命令 ID 之前就会拒绝本存储写入的原因（DEC-955）；自行生成命令 ID 的入口先问它（F-110 第 2 轮 P2-1）。 */
    refusal: () => core.refusal(),
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

/**
 * 恢复槽的放开、交接与共用记录同步（F-110 第 4 轮）：全存储只有这里改动已钉的槽（对外的 pin 除外）。
 * release 是唯一的放开处，align 是唯一的交接处，sync 每次都按记录先放开已落定的、再载入、最后交接。
 */
function createSlots(
  entries: Map<string, Submission>,
  pinned: Map<string, string>,
  notify: () => void,
  recovery?: CommandRecovery,
) {
  /** 放开 key 钉住的全部恢复槽：恢复槽唯一的放开处（命令落定、别页命令已落定时）。 */
  const release = (key: string) =>
    [...pinned].filter(([, holder]) => holder === key).forEach(([slot]) => pinned.delete(slot));
  /**
   * 恢复槽唯一的交接处（F-110 第 4 轮 P2-1）：记录里仍未确认的命令，把它的槽从空槽或已确认的条目手里接过来；
   * 本页处理中、结果未知、冲突的条目占着的槽不抢。与 storage 事件、登记失败谁先谁后无关：拒绝落定时还会再对齐一次。
   */
  const align = (records: readonly PendingRecord[]) => {
    let changed = false;
    records
      .filter((record) => unconfirmed(entries.get(record.key)))
      .filter((record) => entries.get(record.key)!.command?.id === record.commandId)
      .forEach((record) =>
        record.slots.forEach((slot) => {
          const current = pinned.get(slot);
          if (current === record.key || (current !== undefined && isLocked(entries.get(current)))) return;
          pinned.set(slot, record.key);
          changed = true;
        }),
      );
    return changed;
  };
  /**
   * F-110 第 2 轮 P2-2：恢复记录各标签页共用。别页已落定、记录已删的恢复条目先放开；再载入别页（或刷新前）的
   * 未确认命令并锁定，最后按记录对齐恢复槽。本页自己发出的命令不受影响；记录读不出时不动任何条目。
   * keep：刚收到自己结果的条目（本页发出过的命令）这一次不被别的命令替换，提交方拿到的是自己的结果（F110-07）。
   */
  const sync = (keep?: string) => {
    const records = recovery?.load();
    if (!records) return;
    const settled = [...entries].filter(
      ([key, state]) =>
        state.restored &&
        state.status === 'unknown' &&
        !state.reading &&
        !records.some((record) => record.key === key && record.commandId === state.command?.id),
    );
    settled.forEach(([key]) => {
      entries.delete(key);
      release(key);
    });
    const adopted = records.filter(
      (record) =>
        record.key !== keep &&
        !isLocked(entries.get(record.key)) &&
        entries.get(record.key)?.command?.id !== record.commandId,
    );
    adopted.forEach((record) => entries.set(record.key, restoredState(record)));
    const aligned = align(records);
    if (adopted.length || settled.length || aligned) notify();
  };
  /** 槽上占用的命令里第一个“竞争”（本条目自身、再到各槽的占用者）：登记冲突后据此带出原因与占槽命令 ID。 */
  const raceAt = (key: string, slots: readonly string[]) =>
    [key, ...slots.map((slot) => pinned.get(slot))]
      .map((at) => raceOf(at === undefined ? undefined : entries.get(at)))
      .find((race) => race !== undefined);
  return { release, sync, raceAt };
}
/** 存储内部：条目、恢复槽、恢复记录与结果落地（迟到回执丢弃）。 */
function createCore(recovery?: CommandRecovery, precheck?: () => Error | undefined) {
  const entries = new Map<string, Submission>();
  const pinned = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const pins = createPins(notify, pinned);
  const { release, sync, raceAt } = createSlots(entries, pinned, notify, recovery);
  sync();
  recovery?.watch?.(() => sync());
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
   * 结果确定后删掉本命令的恢复记录；登记就被拒的命令没有记录（registered=false），不排删除（第 2 轮 P3）。
   * 结果确定（完成、被拒、冲突）即放开本命令的槽，再同步一次把槽对齐到记录里仍未确认的命令（第 4 轮 P2-1）。
   */
  const land = (key: string, from: Submission, next: Submission, registered = true) => {
    if (entries.get(key) !== from) return undefined;
    entries.set(key, next);
    if (next.command && !unconfirmed(next)) {
      // 删除在同一把跨标签页锁内异步执行，与各页登记按请求先后串行，不阻塞落地；失败不影响已落定的结果。
      // 删除不设等锁上限：未登记的命令若也排一条，他页一直持锁时每次重试都会多残留一条排队请求。
      if (registered) void recovery?.remove(key, next.command.id);
      // 本命令的记录删除前仍在共用记录里：条目还是同一命令 ID，同步不会把它当别页命令载入。
      // 发出过的命令保留自己的结果；登记就被拒的（没发出）让位给别页抢先登记的同一条目（第 2 轮 P2-3）。
      release(key);
      sync(registered ? key : undefined);
    }
    notify();
    return next;
  };
  const refusal = () => {
    const error = precheck?.();
    return error && registerRefusal(error);
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
  return { entries, listeners, notify, pins, put, persist, land, recover, sync, refusal, raceAt };
}
type Core = ReturnType<typeof createCore>;

/** 登记恢复记录被拒的原因 → 提示（DEC-954 / DEC-955 各有专门文案，不复用“其他标签页”与“存储不可用”）。 */
function registerRefusal(error: unknown) {
  if (error instanceof RecoveryLockBusy) return messages.lockBusy;
  if (error instanceof RecoveryLocksUnsupported) return messages.locksUnsupported;
  if (error instanceof RecoveryConflict) return messages.otherTab;
  return messages.recoveryUnavailable;
}
/** 本次未发出、槽已被别的命令占着时的拒绝：两条竞争路径与普通拒绝共用同一种落定形态（输入保留，可重提）。 */
const refusedState = (draft: Omit<Submission, 'status'>, reason: string): Submission => ({
  ...draft,
  status: 'rejected',
  error: new Error(reason),
});
/**
 * 首次提交：登记恢复记录后才发出。提交前同步发现本条目或本命令的槽已被别页的未确认命令占着，和登记时冲突，
 * 都按“竞争”返回（race：原因 + 占槽命令 ID），本次不发出；本页自己锁定中的命令原样返回。
 */
async function submitTo(core: Core, key: string, input: SubmitInput, claim: readonly string[]): Promise<Outcome> {
  // 槽在同步前取：同步可能把本条目的槽改钉到别页的命令上，登记时仍须按这些槽核对占用。
  const slots = [...new Set([...claim, ...core.pins.slotsOf(key)])];
  core.sync();
  const existing = core.entries.get(key);
  if (isLocked(existing)) return existing!.restored ? { ...existing!, race: raceOf(existing) } : existing!;
  const holding = slots
    .map((slot) => core.pins.holder([slot]))
    .find((at) => at && at !== key && isLocked(core.entries.get(at)));
  const held = holding === undefined ? undefined : core.entries.get(holding);
  // 从恢复记录载入的条目没有草稿与基线：结果落定后按本次表单输入重新起算。
  const prior = existing?.status === 'done' || existing?.restored ? undefined : existing;
  const baseline = prior?.baseline ?? input.baseline;
  const revision = prior?.revision ?? input.revision;
  const draft = {
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
  // 同一页的别的命令（批量等）锁着这些槽：原样返回它，不另起命令。别页的命令锁着：本次按竞争拒绝、零发出。
  if (held && !held.restored) return held;
  if (held) {
    const rejected = refusedState(draft, messages.otherTab);
    core.put(key, rejected);
    return { ...rejected, race: raceOf(held) };
  }
  // DEC-955：生成命令 ID 之前拒绝（非安全上下文连 crypto.randomUUID 也没有）；不登记、不发出，输入保留。
  const refused = core.refusal();
  if (refused) {
    const rejected = refusedState(draft, refused);
    core.put(key, rejected);
    return rejected;
  }
  const body = commandBody(input, baseline);
  // 生效日期是调用方提供的租户业务日期，不从浏览器时区推算。
  if (input.effectiveDate !== undefined) body.effectiveDate = input.effectiveDate;
  const command = { ...newCommand(body, revision), ...(input.commandId ? { id: input.commandId } : {}) };
  const state: Submission = { ...draft, status: 'submitting', command };
  // 先钉槽、置处理中再等锁：等锁期间本页同条目再提交被 isLocked 挡住，storage 同步也不接管处理中的条目和它的槽。
  core.pins.pin(slots, key);
  core.put(key, state);
  try {
    await core.persist(key, state, slots);
  } catch (error) {
    // 四类都未发出命令，按“明确拒绝”落定：输入保留，可改正后重提。本命令没有登记，不排删除。
    // 落定时放开本命令的槽并再同步（land）：别页抢先登记的命令此时接过槽，同一条目时条目换成别页的恢复态。
    const rejected = refusedState(state, registerRefusal(error));
    core.land(key, state, rejected, false);
    // 返回本次的拒绝（第 2 轮 P2-3）；只有登记冲突才是竞争，等锁超时（DEC-954）等普通拒绝不带。
    return error instanceof RecoveryConflict ? { ...rejected, race: core.raceAt(key, slots) } : rejected;
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
