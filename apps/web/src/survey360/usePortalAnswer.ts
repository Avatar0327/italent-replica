import { useEffect, useRef, useState } from 'react';
import type { Command } from '../foundation/client.js';
import { useCommandForm, useDraftRefill, type CommandForm } from '../foundation/forms/useCommandForm.js';
import { sameValue } from '../foundation/forms/values.js';
import { isLocked, type Values } from '../foundation/forms/store.js';
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

export function usePortalAnswer(api: PortalClient, path: string, initial: AnswerPage) {
  const [page, setPage] = useState(initial);
  const [draft, setDraft] = useState<Values>(() => sheetValues(initial.sheet));
  const [notice, setNotice] = useState('');
  const [reminder, setReminder] = useState(false);
  const command = useCommandForm(`/api/survey360/portal${path}`);
  const [target] = useState(() => ({ setFieldsValue: (values: Values) => setDraft((old) => ({ ...old, ...values })) }));
  const fields = ['answers', 'suggestion'];
  useDraftRefill(command, fields, target);
  const { readonly, dirty, savable } = answerState(command, page, draft);
  const answers = (draft.answers ?? []) as Answer[];
  const setAnswer = (id: string, patch: Partial<Answer>) => {
    setNotice('');
    setDraft((old) => ({ ...old, answers: withAnswer((old.answers ?? []) as Answer[], id, patch) }));
  };
  const read = async () => {
    const latest = await api.request<AnswerPage>(path);
    setPage(latest);
    return { id: path, revision: latest.sheet.revision, values: sheetValues(latest.sheet) };
  };
  const send = async (request: Command<Values>, operation: Operation) => {
    const result = await sendSheet(api, path, request, operation);
    setPage((old) => ({ ...old, sheet: result }));
    // 保存在途时继续输入的内容留作新草稿（下次自动保存带上），未改动才以回执为准。
    setDraft((old) => (operation === 'save' && !sameValue(old, request.body) ? old : sheetValues(result)));
    setNotice(operation === 'submit' ? m.submitted : m.saved);
    setReminder('reminder' in result && result.reminder === true);
    return { id: path };
  };
  const run = async (operation: Operation) => {
    setNotice('');
    // 已确定失败（被拒、冲突核对后）的另一动作不得把上下文留给本次：否则结果未知时会按旧动作重放。
    const prior = command.peek();
    if (prior && !isLocked(prior) && prior.context?.operation !== operation) command.clear();
    const outcome = await command.submit({
      values: operation === 'save' ? draft : {},
      baseline: sheetValues(page.sheet),
      editableFields: operation === 'save' ? fields : [],
      revision: page.sheet.revision,
      businessId: path,
      context: { operation },
      send: (request) => send(request, operation),
    });
    if (outcome.status === 'done') command.clear();
    return outcome.status === 'done';
  };
  const leave = useDraftProtection({
    savable,
    unsaved: (dirty && !readonly) || command.busy,
    busy: command.busy,
    save: () => run('save'),
  });
  const replay = async () => {
    // 重放固定为原命令当初的动作（槽上下文），不取页面当前按钮。
    const original = command.state?.context?.operation;
    if (original !== 'save' && original !== 'submit') return;
    const outcome = await command.replay((request) => send(request, original));
    if (outcome?.status === 'done') command.clear();
  };
  return {
    page,
    draft,
    notice,
    reminder,
    command,
    readonly,
    dirty,
    answers,
    setAnswer,
    read,
    run,
    leave,
    replay,
    setNotice,
    setDraft,
  };
}

function withAnswer(list: Answer[], id: string, patch: Partial<Answer>) {
  const found = list.find((a) => a.itemId === id);
  return [...list.filter((a) => a.itemId !== id), { ...found, itemId: id, ...patch } as Answer];
}

interface Protection {
  /** 有未保存草稿且当前可保存（非只读、未在途、不是刚被拒的同一份草稿）。 */
  savable: boolean;
  /** 关闭或刷新页面会丢失内容：有可编辑的未保存草稿，或命令在途。 */
  unsaved: boolean;
  busy: boolean;
  save(): Promise<boolean>;
}
/**
 * E3-R22 草稿保护：每 10 秒经同一保存入口自动保存（结果未知、冲突待核对、提交在途时 savable 为假，不另起命令）；
 * 关闭或刷新前提示；返回列表前先保存，保存未完成（被拒、结果未知）时留在本页显示原因，草稿仍在页面级内核槽里。
 */
function useDraftProtection({ savable, unsaved, busy, save }: Protection) {
  const tick = useRef<() => void>(undefined);
  tick.current = () => {
    if (savable) void save();
  };
  useEffect(() => {
    const timer = setInterval(() => tick.current?.(), AUTOSAVE_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!unsaved) return;
    const guard = (event: Event) => event.preventDefault();
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [unsaved]);
  return async (back: () => void) => {
    if (busy) return;
    if (savable && !(await save())) return;
    back();
  };
}

function answerState(command: CommandForm, page: AnswerPage, draft: Values) {
  const operation = command.state?.context?.operation;
  // 保存在途时仍可继续作答（自动保存不打断输入）；提交在途、结果未知、冲突待核对时只读。
  const saving = command.busy && operation === 'save';
  const readonly =
    (command.locked && !saving) || page.sheet.status === 'submitted' || page.activity.status !== 'enabled';
  const dirty = !sameValue(draft, sheetValues(page.sheet));
  // 已被拒的同一份草稿不再自动重发，用户改动后再保存。
  const refused = command.status === 'rejected' && operation === 'save' && sameValue(command.state?.values, draft);
  return { readonly, dirty, savable: !readonly && dirty && !command.busy && !refused };
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
