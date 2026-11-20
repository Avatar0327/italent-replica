import { useEffect, useRef, useState } from 'react';
import type { Command } from '../foundation/client.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { isLocked, type Submission, type Values } from '../foundation/forms/store.js';
import {
  sheetReceipt,
  sheetValues,
  type Answer,
  type AnswerPage,
  type PortalClient,
  type Sheet,
} from './portal-client.js';
import {
  adoptSheet,
  answerState,
  blockedMessage,
  fields,
  leaveGuarded,
  restored,
  type AnswerState,
} from './portal-adoption.js';
import { portalMessages as m } from './portal-messages.js';

/** E3-R22：作答页每 10 秒自动保存，支持断点续答。 */
export const AUTOSAVE_MS = 10_000;
type Operation = 'save' | 'submit';

/**
 * 页面上只有一份实时答卷 live 与一份确认的答卷 page；采用哪份状态只按 portal-adoption.ts 的规则 ①～④：
 * 回执、重放回执、回查、409 重读都经 adopt → adoptSheet（revision 单调，submitted 不退回）；
 * 输入经 edit 记编辑事件，保存发出时清零（dirty 推导见 answerState）；刷新、返回都按 leaveGuarded 拦截；
 * 打开时只有未确认命令的槽才恢复命令快照（restored），已确认的槽清掉，以 GET 为准。
 * 内核槽里已发出的命令快照只用于结果未知时原样重放，不在核对表显示。
 * 登录会话、活动（作答路径）、页面挂载构成会话代次：每个异步续体在 await 之后先核对，变了就停，不再发送。
 */
export function usePortalAnswer(api: PortalClient, path: string, initial: AnswerPage) {
  const command = useCommandForm(`/api/survey360/portal${path}`);
  const { ref, page, draft, assign, showPage } = useLiveSheet(initial, command);
  const generation = useGeneration(api, path);
  const [notice, setNotice] = useState('');
  const [warning, setWarning] = useState('');
  const [reminder, setReminder] = useState(false);
  const { readonly, dirty } = answerState(command.state, page, draft, ref.current);
  const adopt = (next: AnswerPage, keep: readonly string[]) => {
    const { page: confirmed, live } = ref.current;
    const result = adoptSheet({ confirmed, next, live, keep });
    if (result.advanced) {
      assign(result.live);
      showPage(result.page);
    }
    return result;
  };
  const edit = (field: string, next: (old: Values) => Values) => {
    setNotice('');
    setWarning('');
    ref.current.edits.add(field);
    ref.current.seq += 1;
    ref.current.held = false;
    assign(next(ref.current.live));
  };
  // 回查 / 409 重读：保留发出后有过编辑的字段与未确认命令改过的字段；交给内核的是采用后的确认答卷。
  const read = async () => {
    const current = generation();
    const latest = await api.request<AnswerPage>(path);
    const confirmed = current() ? adopt(latest, [...ref.current.edits, ...pendingFields(command.peek())]).page : latest;
    return { id: path, revision: confirmed.sheet.revision, values: sheetValues(confirmed.sheet) };
  };
  const send = async (request: Command<Values>, operation: Operation) => {
    const current = generation();
    const result = await sendSheet(api, path, request, operation);
    // 代次变了（登出、卸载、换活动）：回执只交内核落定，不再改页面。
    if (current()) {
      // 回执保留整份页面值；历史回执（重放返回台账原响应）只确认命令成功，并暂缓自动保存，不盖过更新的版本。
      const { advanced } = adopt({ ...ref.current.page, sheet: result }, fields);
      if (!advanced) ref.current.held = true;
      else setReminder('reminder' in result && result.reminder === true);
      setNotice(operation === 'submit' ? m.submitted : m.saved);
    }
    return { id: path };
  };
  const reset = () => {
    setNotice('');
    setWarning('');
  };
  const run = runner({ command, ref, generation, path, send, reset });
  const now = () => {
    const marks = ref.current;
    return { ...answerState(command.peek(), marks.page, marks.live, marks), seq: marks.seq };
  };
  const blocked = (state: AnswerState) => setWarning(blockedMessage(state));
  const leave = useDraftProtection({ now, save: () => run('save'), blocked, generation });
  const replay = async () => {
    // 重放固定为原命令当初的动作（槽上下文），不取页面当前按钮。
    const original = command.state?.context?.operation;
    if (original !== 'save' && original !== 'submit') return;
    ref.current.inherited = false;
    const outcome = await command.replay((request) => send(request, original));
    if (outcome?.status === 'done') command.clear();
  };
  // F-123 §136：核对只解锁，不发送。用户已逐字段核过差异，编辑记录清零、暂缓自动保存，直到新输入或显式保存。
  const confirm = () => {
    command.confirm();
    if (command.peek()?.status !== 'idle') return;
    ref.current.edits.clear();
    ref.current.held = true;
  };
  const setAnswer = (id: string, patch: Partial<Answer>) =>
    edit('answers', (old) => ({ ...old, answers: withAnswer((old.answers ?? []) as Answer[], id, patch) }));
  const setSuggestion = (suggestion: string) => edit('suggestion', (old) => ({ ...old, suggestion }));
  const answers = (draft.answers ?? []) as Answer[];
  const view = { page, draft, notice, warning, reminder, readonly, dirty, answers };
  return { ...view, command: { ...command, confirm }, setAnswer, setSuggestion, read, run, leave, replay };
}

/** 未确认命令（处理中、结果未知、冲突）改过的字段：回查与重读时整字段保留页面值。 */
const pendingFields = (state?: Submission) => (state && isLocked(state) ? state.editedFields : []);

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
    // 已有未确认命令时内核不会发出新命令：此时不得清编辑记录。
    if (isLocked(command.peek())) return false;
    reset();
    // 已确定失败（被拒、冲突核对后）的另一动作不得把上下文留给本次：否则结果未知时会按旧动作重放。
    const prior = command.peek();
    if (prior && prior.context?.operation !== operation) command.clear();
    const current = generation();
    const marks = ref.current;
    const { live, page } = marks;
    // 规则 ②：保存发出即清零编辑记录，之后的输入才算“发出后有过编辑”；显式保存也解除暂缓。
    if (operation === 'save') {
      marks.edits.clear();
      marks.held = false;
    }
    marks.inherited = false;
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
 * 页面实时答卷、当前确认的答卷与编辑记录：同时写进 ref，异步回执后按当前值（不是渲染快照）判断。
 * 打开时按规则 ④ 取初值；没有未确认命令的槽（完成、被拒、核对后）随即清掉，不带回旧草稿与旧错误。
 */
function useLiveSheet(initial: AnswerPage, command: CommandForm) {
  // 确认的答卷是本页自己的副本：调用方之后改动传入的对象，不能悄悄改掉 dirty 的比较基准。
  const [page, setPage] = useState(() => structuredClone(initial));
  const [draft, setDraft] = useState<Values>(() => restored(page.sheet, command.state));
  // 打开时槽里已有未确认命令：是继承来的，本次挂载发出命令前按只读处理（DEC-948）。
  const inherited = isLocked(command.state);
  const ref = useRef({ page, live: draft, edits: new Set<string>(), seq: 0, held: false, inherited });
  useEffect(() => {
    if (!isLocked(command.peek())) command.clear();
  }, []);
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

type Snapshot = AnswerState & { seq: number };
interface Protection {
  /** 按存储与页面的当前值计算（不是渲染时的快照）：异步保存回执后据此判断是否还有未保存内容。 */
  now(): Snapshot;
  save(): Promise<boolean>;
  blocked(state: AnswerState): void;
  generation: Generation;
}
/**
 * E3-R22 草稿保护，按规则 ③ 拦截：每 10 秒经同一保存入口自动保存（结果未知、冲突待核对、暂缓、提交在途、
 * 活动暂停或已提交时不自动保存）；关闭或刷新前有未保存内容或未确认命令就提示；返回列表前先保存，回执后仍有
 * 未保存内容就再保存，保存未完成（被拒、结果未知、代次已变）时留在本页；保存不了时提示、不离开。
 */
function useDraftProtection({ now, save, blocked, generation }: Protection) {
  const latest = useRef({ now, save });
  latest.current = { now, save };
  useEffect(() => {
    const timer = setInterval(() => {
      if (latest.current.now().savable) void latest.current.save();
    }, AUTOSAVE_MS);
    const guard = (event: Event) => {
      if (leaveGuarded(latest.current.now())) event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', guard);
    };
  }, []);
  return async (back: () => void) => {
    const current = generation();
    for (let state = now(); leaveGuarded(state); state = now()) {
      if (!state.savable) return blocked(state);
      if (!(await save()) || !current()) return;
      // 回执后没有新输入却仍有未保存内容（比较口径与服务端不符）：停下提示，不反复发送。
      const after = now();
      if (leaveGuarded(after) && after.seq === state.seq) return blocked(after);
    }
    back();
  };
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
