import { useEffect, useRef, useState } from 'react';
import type { Command } from '../foundation/client.js';
import { useCommandForm, useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { sameValue } from '../foundation/forms/values.js';
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
 * 作答状态分两份：内核槽里是已发出的命令快照（结果未知时按它原样重放）；live 是页面上的实时答卷。
 * synced 记 live 与内核最近一次对齐的值（发出时的快照、重读回填值）；live 与它不同的字段就是
 * “发出后又改的内容”（未保存标记），离开、回查 / 重读回填、核对解锁都先看这个标记。
 */
export function usePortalAnswer(api: PortalClient, path: string, initial: AnswerPage) {
  const { ref, page, draft, assign, showPage } = useLiveSheet(initial);
  const [notice, setNotice] = useState('');
  const [warning, setWarning] = useState('');
  const [reminder, setReminder] = useState(false);
  const command = useCommandForm(`/api/survey360/portal${path}`);
  const [target] = useState(() => ({ setFieldsValue: (values: Values) => assign(refill(ref.current, values)) }));
  useDraftRefill(command, fields, target);
  const { readonly, dirty } = answerState(command.state, page, draft, false);
  const answers = (draft.answers ?? []) as Answer[];
  const edit = (next: (old: Values) => Values) => {
    setNotice('');
    setWarning('');
    ref.current.touched = true;
    assign(next(ref.current.live));
  };
  const setAnswer = (id: string, patch: Partial<Answer>) =>
    edit((old) => ({ ...old, answers: withAnswer((old.answers ?? []) as Answer[], id, patch) }));
  const read = async () => {
    const latest = await api.request<AnswerPage>(path);
    showPage(latest);
    return { id: path, revision: latest.sheet.revision, values: sheetValues(latest.sheet) };
  };
  const send = async (request: Command<Values>, operation: Operation) => {
    const result = await sendSheet(api, path, request, operation);
    showPage({ ...ref.current.page, sheet: result });
    // 保存在途时继续输入的内容留作新草稿（下次保存带上），未改动才以回执为准。
    if (operation !== 'save' || sameValue(ref.current.live, request.body)) assign(sheetValues(result));
    ref.current.synced = undefined;
    setNotice(operation === 'submit' ? m.submitted : m.saved);
    setReminder('reminder' in result && result.reminder === true);
    return { id: path };
  };
  const run = async (operation: Operation) => {
    setNotice('');
    setWarning('');
    // 已确定失败（被拒、冲突核对后）的另一动作不得把上下文留给本次：否则结果未知时会按旧动作重放。
    const prior = command.peek();
    if (prior && !isLocked(prior) && prior.context?.operation !== operation) command.clear();
    const { live, page: current } = ref.current;
    if (!isLocked(command.peek())) ref.current.synced = live;
    const outcome = await command.submit({
      values: operation === 'save' ? live : {},
      baseline: sheetValues(current.sheet),
      editableFields: operation === 'save' ? fields : [],
      revision: current.sheet.revision,
      businessId: path,
      context: { operation },
      send: (request) => send(request, operation),
    });
    if (outcome.status === 'done') command.clear();
    return outcome.status === 'done';
  };
  const now = () => {
    const state = command.peek();
    const { live, synced, page: current, touched } = ref.current;
    return { ...answerState(state, current, live, touched), pending: pendingInput(state, live, synced) };
  };
  const leave = useDraftProtection({ now, save: () => run('save'), blocked: () => setWarning(m.unsavedInput) });
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
  const setSuggestion = (suggestion: string) => edit((old) => ({ ...old, suggestion }));
  const view = { page, draft, notice, warning, reminder, readonly, dirty, answers };
  return { ...view, command: { ...command, confirm }, setAnswer, setSuggestion, read, run, leave, replay };
}

/** 页面实时答卷与当前答卷记录：同时写进 ref，异步回执后按当前值（不是渲染快照）判断。 */
function useLiveSheet(initial: AnswerPage) {
  const [page, setPage] = useState(initial);
  const [draft, setDraft] = useState<Values>(() => sheetValues(initial.sheet));
  const ref = useRef({ page, live: draft, synced: undefined as Values | undefined, touched: false });
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

function withAnswer(list: Answer[], id: string, patch: Partial<Answer>) {
  const found = list.find((a) => a.itemId === id);
  return [...list.filter((a) => a.itemId !== id), { ...found, itemId: id, ...patch } as Answer];
}

interface Live {
  live: Values;
  synced: Values | undefined;
}
/** 内核回填（回查 / 重读 / 重开恢复）：发出后又改的字段保留页面值，其余取内核值并记为已对齐。 */
function refill(current: Live, values: Values) {
  const { live, synced } = current;
  const applied = Object.fromEntries(
    Object.entries(values).filter(([field]) => !synced || sameValue(live[field], synced[field])),
  );
  current.synced = { ...(synced ?? {}), ...applied };
  return { ...live, ...applied };
}
/** 未保存标记：槽里的命令未完成，且页面上有发出后又改、内核快照里没有的内容。 */
function pendingInput(state: Submission | undefined, live: Values, synced: Values | undefined) {
  if (!state || state.status === 'done' || !synced) return false;
  return Object.keys(synced).some((field) => !sameValue(live[field], synced[field]));
}

type Snapshot = ReturnType<typeof answerState> & { pending: boolean };
interface Protection {
  /** 按存储与页面的当前值计算（不是渲染时的快照）：异步保存回执后据此判断是否还有更新的草稿。 */
  now(): Snapshot;
  save(): Promise<boolean>;
  blocked(): void;
}
/**
 * E3-R22 草稿保护：每 10 秒经同一保存入口自动保存（结果未知、冲突待核对、核对后未再输入、提交在途时不自动保存）；
 * 关闭或刷新前，有未保存草稿、命令在途或未保存标记时提示；返回列表前先保存，回执后仍有更新的草稿就再保存，
 * 保存未完成（被拒、结果未知）时留在本页；有保存不了的未保存标记内容时提示、不离开。
 */
function useDraftProtection({ now, save, blocked }: Protection) {
  const latest = useRef({ now, save });
  latest.current = { now, save };
  useEffect(() => {
    const timer = setInterval(() => {
      if (latest.current.now().savable) void latest.current.save();
    }, AUTOSAVE_MS);
    const guard = (event: Event) => {
      const state = latest.current.now();
      if ((state.dirty && !state.closed) || state.busy || state.pending) event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', guard);
    };
  }, []);
  return async (back: () => void) => {
    if (now().busy) return;
    for (let state = now(); state.savable || state.pending; state = now()) {
      if (!state.savable) return blocked();
      if (!(await save())) return;
    }
    back();
  };
}

/** state 是内核槽的当前状态；touched 为“冲突核对解锁后用户有过新输入”。 */
function answerState(state: Submission | undefined, page: AnswerPage, draft: Values, touched: boolean) {
  const operation = state?.context?.operation;
  const busy = state?.status === 'submitting';
  // 保存在途时仍可继续作答（自动保存不打断输入）；提交在途、结果未知、冲突待核对时只读。
  const saving = busy && operation === 'save';
  const closed = page.sheet.status === 'submitted' || page.activity.status !== 'enabled';
  const readonly = (isLocked(state) && !saving) || closed;
  const dirty = !sameValue(draft, sheetValues(page.sheet));
  // 已被拒的同一份草稿不再自动重发，用户改动后再保存。
  const refused = state?.status === 'rejected' && operation === 'save' && sameValue(state.values, draft);
  // 冲突核对后（槽为 idle 且带最新记录）在用户新输入前不自动写入。
  const reviewed = state?.status === 'idle' && !!state.latest && !touched;
  return { readonly, closed, dirty, busy, savable: !readonly && dirty && !busy && !refused && !reviewed };
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
