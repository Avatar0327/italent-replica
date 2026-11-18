import { useEffect, useRef, useState } from 'react';
import type { Command } from '../foundation/client.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { changedFields, refillDraft } from '../foundation/forms/values.js';
import { isLocked, type Submission, type Values } from '../foundation/forms/store.js';
import {
  sheetReceipt,
  sheetValues,
  type Answer,
  type AnswerPage,
  type PortalClient,
  type Sheet,
} from './portal-client.js';
import { portalMessages as m } from './portal-messages.js';

/** E3-R22：作答页每 10 秒自动保存，支持断点续答。 */
export const AUTOSAVE_MS = 10_000;
type Operation = 'save' | 'submit';
const fields = ['answers', 'suggestion'];

/**
 * 页面上只有一份实时答卷 live。“未保存”由数据推导：dirty = live 与服务端最近确认的答卷（page.sheet）不同；
 * 确认只经 adopt 一个入口更新（保存 / 提交回执、回查命中、409 重读）。离开、返回、刷新提示、立即保存可用、
 * 核对表“我的输入”都只读这个推导结果；结果未知 / 冲突锁只决定能不能发送，不决定有没有未保存内容。
 * 内核槽里已发出的命令快照只用于结果未知时原样重放，不参与 dirty，也不在核对表显示。
 * 登录会话、活动（作答路径）、页面挂载构成会话代次：每个异步续体在 await 之后先核对，变了就停，不再发送。
 */
export function usePortalAnswer(api: PortalClient, path: string, initial: AnswerPage) {
  const command = useCommandForm(`/api/survey360/portal${path}`);
  const { ref, page, draft, assign, showPage } = useLiveSheet(initial, command.state);
  const generation = useGeneration(api, path);
  const [notice, setNotice] = useState('');
  const [warning, setWarning] = useState('');
  const [reminder, setReminder] = useState(false);
  const { readonly, dirty } = answerState(command.state, page, draft, false);
  // 唯一的确认入口：本页改过的字段整字段保留页面值（本页为准，不逐题合并），其余跟随服务端答卷。
  const adopt = (next: AnswerPage) => {
    const { live, page: confirmed } = ref.current;
    const edited = unsaved(live, sheetValues(confirmed.sheet));
    assign(refillDraft({ values: live, latest: sheetValues(next.sheet), edited, submittable: fields }));
    showPage(next);
  };
  const edit = (next: (old: Values) => Values) => {
    setNotice('');
    setWarning('');
    ref.current.touched = true;
    assign(next(ref.current.live));
  };
  const read = async () => {
    const current = generation();
    const latest = await api.request<AnswerPage>(path);
    if (current()) adopt(latest);
    return { id: path, revision: latest.sheet.revision, values: sheetValues(latest.sheet) };
  };
  const send = async (request: Command<Values>, operation: Operation) => {
    const current = generation();
    const result = await sendSheet(api, path, request, operation);
    // 代次变了（登出、卸载、换活动）：回执只交内核落定，不再改页面。
    if (current()) {
      adopt({ ...ref.current.page, sheet: result });
      setNotice(operation === 'submit' ? m.submitted : m.saved);
      setReminder('reminder' in result && result.reminder === true);
    }
    return { id: path };
  };
  const reset = () => {
    setNotice('');
    setWarning('');
  };
  const run = runner({ command, ref, generation, path, send, reset });
  const now = () => {
    const { page: confirmed, live, touched } = ref.current;
    return { ...answerState(command.peek(), confirmed, live, touched), live };
  };
  const blocked = (state: Snapshot) => setWarning(blockedMessage(state));
  const leave = useDraftProtection({ now, save: () => run('save'), blocked, generation });
  const replay = async () => {
    // 重放固定为原命令当初的动作（槽上下文），不取页面当前按钮。
    const original = command.state?.context?.operation;
    if (original !== 'save' && original !== 'submit') return;
    const outcome = await command.replay((request) => send(request, original));
    if (outcome?.status === 'done') command.clear();
  };
  // F-123 §136：核对只解锁，不发送；之后由用户新输入或点保存显式发起下一次写入。
  const confirm = () => {
    ref.current.touched = false;
    command.confirm();
  };
  const setAnswer = (id: string, patch: Partial<Answer>) =>
    edit((old) => ({ ...old, answers: withAnswer((old.answers ?? []) as Answer[], id, patch) }));
  const setSuggestion = (suggestion: string) => edit((old) => ({ ...old, suggestion }));
  const answers = (draft.answers ?? []) as Answer[];
  const view = { page, draft, notice, warning, reminder, readonly, dirty, answers };
  return { ...view, command: { ...command, confirm }, setAnswer, setSuggestion, read, run, leave, replay };
}

type CommandForm = ReturnType<typeof useCommandForm>;
type LiveRef = ReturnType<typeof useLiveSheet>['ref'];
type Generation = ReturnType<typeof useGeneration>;
interface Runner {
  command: CommandForm;
  ref: LiveRef;
  generation: Generation;
  path: string;
  send(request: Command<Values>, operation: Operation): Promise<{ id: string }>;
  reset(): void;
}
/** 保存 / 提交经同一入口：按当前确认的答卷与 revision 发出；完成后放开恢复槽，代次变了就不再让调用方继续。 */
function runner({ command, ref, generation, path, send, reset }: Runner) {
  return async (operation: Operation) => {
    reset();
    // 已确定失败（被拒、冲突核对后）的另一动作不得把上下文留给本次：否则结果未知时会按旧动作重放。
    const prior = command.peek();
    if (prior && !isLocked(prior) && prior.context?.operation !== operation) command.clear();
    const current = generation();
    const { live, page } = ref.current;
    const outcome = await command.submit({
      values: operation === 'save' ? live : {},
      baseline: sheetValues(page.sheet),
      editableFields: operation === 'save' ? fields : [],
      revision: page.sheet.revision,
      businessId: path,
      context: { operation },
      send: (request) => send(request, operation),
    });
    if (outcome.status === 'done') command.clear();
    return outcome.status === 'done' && current();
  };
}

/**
 * 页面实时答卷与当前确认的答卷：同时写进 ref，异步回执后按当前值（不是渲染快照）判断。
 * 重开时槽里还有未完成的命令（处理中、结果未知、冲突、被拒、核对后）：按内核草稿恢复，锁与重放仍以槽为准。
 */
function useLiveSheet(initial: AnswerPage, state: Submission | undefined) {
  // 确认的答卷是本页自己的副本：调用方之后改动传入的对象，不能悄悄改掉 dirty 的比较基准。
  const [page, setPage] = useState(() => structuredClone(initial));
  const [draft, setDraft] = useState<Values>(() => restored(page.sheet, state));
  const ref = useRef({ page, live: draft, touched: false });
  const assign = (live: Values) => {
    ref.current.live = live;
    setDraft(live);
  };
  const showPage = (next: AnswerPage) => {
    ref.current.page = next;
    setPage(next);
  };
  return { ref, page, draft, assign, showPage };
}
function restored(sheet: Sheet, state: Submission | undefined): Values {
  const values = sheetValues(sheet);
  if (!state || state.status === 'done') return values;
  const { values: kept, latest, editedFields: edited } = state;
  return { ...values, ...refillDraft({ values: kept, latest: latest?.values, edited, submittable: fields }) };
}

/** 会话代次：卸载（含登出）、换会话客户端或换活动路径时递增；generation() 取当前代次，返回的函数核对是否仍是它。 */
function useGeneration(api: PortalClient, path: string) {
  const counter = useRef(0);
  useEffect(
    () => () => {
      counter.current += 1;
    },
    [api, path],
  );
  return () => {
    const at = counter.current;
    return () => counter.current === at;
  };
}

function withAnswer(list: Answer[], id: string, patch: Partial<Answer>) {
  const found = list.find((a) => a.itemId === id);
  return [...list.filter((a) => a.itemId !== id), { ...found, itemId: id, ...patch } as Answer];
}

/** 页面 DTO 的比较口径：答案按题目排序、补充说明与综合建议去首尾空白（与服务端保存口径一致）。 */
function canonical(values: Values): Values {
  const answers = ((values.answers ?? []) as Answer[])
    .map((a) => ({ itemId: a.itemId, optionId: a.optionId, remark: (a.remark ?? '').trim() }))
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
  return { answers, suggestion: String(values.suggestion ?? '').trim() };
}
/** 两份答卷不同的字段。 */
const unsaved = (a: Values, b: Values) => changedFields(canonical(a), canonical(b), fields);

type Snapshot = ReturnType<typeof answerState> & { live: Values };
interface Protection {
  /** 按存储与页面的当前值计算（不是渲染时的快照）：异步保存回执后据此判断是否还有未保存内容。 */
  now(): Snapshot;
  save(): Promise<boolean>;
  blocked(state: Snapshot): void;
  generation: Generation;
}
/**
 * E3-R22 草稿保护，只看 dirty：每 10 秒经同一保存入口自动保存（结果未知、冲突待核对、核对后未再输入、提交在途、
 * 活动暂停或已提交时不自动保存）；关闭或刷新前有未保存内容或命令在途就提示；返回列表前先保存，回执后仍有未保存内容
 * 就再保存，保存未完成（被拒、结果未知、代次已变）时留在本页；有保存不了的未保存内容时提示、不离开。
 */
function useDraftProtection({ now, save, blocked, generation }: Protection) {
  const latest = useRef({ now, save });
  latest.current = { now, save };
  useEffect(() => {
    const timer = setInterval(() => {
      if (latest.current.now().savable) void latest.current.save();
    }, AUTOSAVE_MS);
    const guard = (event: Event) => {
      const state = latest.current.now();
      if (state.dirty || state.busy) event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', guard);
    };
  }, []);
  return async (back: () => void) => {
    const current = generation();
    for (let state = now(); !state.busy && state.dirty; state = now()) {
      if (!state.savable) return blocked(state);
      if (!(await save()) || !current()) return;
      // 回执后没有新输入却仍不一致（比较口径与服务端不符）：停下提示，不反复发送。
      const after = now();
      if (after.dirty && !unsaved(state.live, after.live).length) return blocked(after);
    }
    if (!now().busy) back();
  };
}
// 槽里还有未确认的命令时先提示确认保存结果（回查、按原命令重放仍可用），确认后才按暂停 / 已提交提示。
function blockedMessage(state: Snapshot) {
  if (state.locked || (!state.paused && !state.submitted)) return m.unsavedInput;
  return state.paused ? m.pausedUnsaved : m.submittedUnsaved;
}

/** state 是内核槽的当前状态；touched 为“冲突核对解锁后用户有过新输入”。 */
function answerState(state: Submission | undefined, page: AnswerPage, draft: Values, touched: boolean) {
  const operation = state?.context?.operation;
  const busy = state?.status === 'submitting';
  // 保存在途时仍可继续作答（自动保存不打断输入）；提交在途、结果未知、冲突待核对时只读。
  const saving = busy && operation === 'save';
  const submitted = page.sheet.status === 'submitted';
  const paused = !submitted && page.activity.status !== 'enabled';
  const locked = isLocked(state);
  const readonly = (locked && !saving) || submitted || paused;
  const dirty = unsaved(draft, sheetValues(page.sheet)).length > 0;
  // 已被拒的同一份草稿不再自动重发，用户改动后再保存。
  const refused = state?.status === 'rejected' && operation === 'save' && !unsaved(state.values, draft).length;
  // 冲突核对后（槽为 idle 且带最新记录）在用户新输入前不自动写入。
  const reviewed = state?.status === 'idle' && !!state.latest && !touched;
  const savable = !readonly && dirty && !busy && !refused && !reviewed;
  return { readonly, locked, submitted, paused, dirty, busy, savable };
}

/** 动作决定方法与路径（保存 PUT 原单、提交 POST …/submit）；回执按实际提交的 revision 校验。 */
async function sendSheet(api: PortalClient, path: string, request: Command<Values>, operation: Operation) {
  const submit = operation === 'submit';
  const value = await api.request<Sheet & { reminder?: boolean }>(
    `${path}${submit ? '/submit' : ''}`,
    submit ? 'POST' : 'PUT',
    request.body,
    request,
  );
  return sheetReceipt(value, request.revision!, operation);
}
