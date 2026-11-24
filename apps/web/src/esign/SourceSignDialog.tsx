import { esignFailureText } from '@italent/domain';
import { Button, Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { ApiError, rejectionMessage } from '../foundation/client.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { commandResultPath } from '../foundation/forms/command-result.js';
import { createFormStore } from '../foundation/forms/store.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { useRead } from '../part-time/useRead.js';
import { SourceSignHistory } from './SourceSignHistory.js';
import { TemplatePicker, chosenTemplates } from './TemplatePicker.js';
import { m } from './messages.js';
import { minePath, parseMineDetail } from './mine-model.js';
import {
  SOURCE_TEMPLATE_LIMIT,
  parseSourceSignContext,
  parseSourceSignReceipt,
  sourceSignKey,
  sourceSignPath,
  sourceStatus,
  unreadable,
  type SignSource,
} from './source-sign-model.js';
import { tasksChanged, useTasksChanged } from './task-changes.js';

const s = m.source;
const store = createFormStore();
// F-123 保存原来源、原版本和未确认的命令。任务 ID 是成功回执的另一条轴，按命令 ID 跟随原槽。
const taskByCommand = new Map<string, string>();

export interface SourceSignDialogProps {
  source: SignSource;
  onClose(): void;
}

/** 来源对象控制入口是否可用。打开后由签署上下文提供当前资格、版本和模板。 */
export function SourceSignDialog(props: SourceSignDialogProps) {
  const key = sourceSignKey(useSession(), props.source);
  return <OpenDialog key={key} {...props} />;
}

function useContextRead(path: string | null, source: SignSource) {
  const read = useRead<unknown>(path);
  try {
    const data = read.data === undefined ? undefined : parseSourceSignContext(read.data, source);
    return { ...read, data };
  } catch (error) {
    return { ...read, data: undefined, error };
  }
}

function useSourceCommand(source: SignSource) {
  const client = useApiClient();
  const form = useCommandForm(sourceSignKey(useSession(), source), store);
  const epoch = useRef<AbortController>(null);
  useEffect(() => {
    const current = new AbortController();
    epoch.current = current;
    return () => current.abort();
  }, []);
  const commandId = form.state?.command?.id;
  const taskId = commandId && form.status === 'done' ? taskByCommand.get(commandId) : undefined;

  async function submit(templateIds: string[], revision: number) {
    const signal = epoch.current?.signal;
    if (!signal || signal.aborted) return;
    if (form.status === 'rejected') form.clear();
    await form.submit({
      values: { templateIds },
      baseline: {},
      editableFields: ['templateIds'],
      revision,
      businessId: source.id,
      async send(command) {
        signal.throwIfAborted();
        const raw = await client.request<unknown>(`${sourceSignPath(source)}/esign-tasks`, {
          method: 'POST',
          command,
          signal,
        });
        signal.throwIfAborted();
        const receipt = parseSourceSignReceipt(raw, source);
        taskByCommand.set(command.id, receipt.taskId);
        return { id: receipt.sourceId };
      },
    });
  }

  function queryResult() {
    // F-553 将查无回执和来源不可读统一返回 404。没有肯定结论时保留原槽，禁止重新 POST。
    const signal = epoch.current?.signal;
    if (!signal || signal.aborted) return;
    void form.recoverResult(async (command) => {
      const raw = await client.request<unknown>(commandResultPath(command.id), { signal });
      signal.throwIfAborted();
      const receipt = parseSourceSignReceipt(raw, source);
      taskByCommand.set(command.id, receipt.taskId);
      return { status: 'succeeded', businessId: receipt.sourceId };
    });
  }

  const clear = () => {
    if (commandId && taskId) taskByCommand.delete(commandId);
    if (!form.locked) form.clear();
  };
  return { form, epoch, taskId, submit, queryResult, clear };
}

async function refreshSubmission(
  form: ReturnType<typeof useCommandForm>,
  source: SignSource,
  signal: AbortSignal,
  read: () => Promise<unknown>,
) {
  const reload = async () => {
    const raw = await read();
    signal.throwIfAborted();
    return parseSourceSignContext(raw, source);
  };
  if (form.status === 'conflict') {
    await form.reread(async () => {
      const current = await reload();
      return { id: source.id, revision: current.revision, values: {} };
    });
    if (!signal.aborted) form.confirm();
  } else {
    await reload();
    form.clear();
  }
}

function useSourceSign(source: SignSource) {
  const command = useSourceCommand(source);
  const { form, taskId } = command;
  const [ids, setIds] = useState<string[]>(() => (form.state?.values.templateIds as string[] | undefined) ?? []);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>();
  const unknown = form.status === 'unknown';
  const error = form.state?.error;
  const readError = form.state?.readError ?? refreshError;
  const variableDenied = error instanceof ApiError && error.code === 'FIELD_FORBIDDEN';
  const denied = [readError, variableDenied ? undefined : error].find(unreadable);
  const conflict = error instanceof ApiError && error.status === 409;
  const context = useContextRead(
    taskId || denied || unknown ? null : `${sourceSignPath(source)}/esign-context`,
    source,
  );
  const options = { items: context.data?.items, error: context.error, loading: context.loading };
  const chosen = chosenTemplates(options, ids);
  const canSend =
    !!context.data?.canInitiate &&
    !form.locked &&
    !taskId &&
    !conflict &&
    !denied &&
    !refreshing &&
    chosen.length >= 1 &&
    chosen.length <= SOURCE_TEMPLATE_LIMIT;

  async function refreshContext() {
    const signal = command.epoch.current?.signal;
    if (refreshing || !signal || signal.aborted) return;
    setRefreshing(true);
    setRefreshError(undefined);
    try {
      await refreshSubmission(form, source, signal, context.reload);
    } catch (cause) {
      setRefreshError(cause);
    } finally {
      setRefreshing(false);
    }
  }

  return {
    ...command,
    context,
    options,
    ids,
    setIds,
    refreshing,
    refreshContext,
    unknown,
    conflict,
    error,
    readError,
    variableDenied,
    denied,
    canSend,
    confirm() {
      if (canSend && context.data) void command.submit(chosen, context.data.revision);
    },
  };
}

type SourceFlow = ReturnType<typeof useSourceSign>;

function OpenDialog({ source, onClose }: SourceSignDialogProps) {
  const flow = useSourceSign(source);
  const { form, taskId, unknown, denied, context } = flow;
  const [readTask, setReadTask] = useState<string>();
  useEffect(() => {
    if (taskId) tasksChanged([taskId]);
  }, [taskId]);

  const dismissible = !form.busy && (!unknown || !!denied);
  const dismiss = () => {
    if (!dismissible) return;
    // 已提交但还未读到任务时保留回执，重开仍只读同一任务。
    if (!taskId || taskId === readTask) flow.clear();
    onClose();
  };
  const accessError = denied ?? (unreadable(context.error) ? context.error : undefined);
  return (
    <Modal
      open
      title={s.title}
      maskClosable={false}
      closable={dismissible}
      keyboard={dismissible}
      onCancel={dismiss}
      footer={<DialogFooter flow={flow} dismissible={dismissible} dismiss={dismiss} />}
    >
      {!!accessError && (
        <p role="alert">
          {accessError instanceof ApiError && accessError.status === 404 ? s.missingSource : s.noAccess}
        </p>
      )}
      {!taskId && !unknown && !accessError && <SourceTemplateFields flow={flow} />}
      <CommandFeedback flow={flow} />
      {taskId && <SubmittedTask key={taskId} id={taskId} onRead={setReadTask} />}
      <SourceSignHistory source={source} />
    </Modal>
  );
}

function DialogFooter({ flow, dismissible, dismiss }: { flow: SourceFlow; dismissible: boolean; dismiss(): void }) {
  const { form, taskId, denied, unknown, conflict, refreshing, canSend } = flow;
  return (
    <>
      <Button disabled={!dismissible} onClick={dismiss}>
        {taskId || denied ? s.close : s.cancel}
      </Button>
      {unknown && !denied && (
        <Button loading={form.state?.reading} onClick={flow.queryResult}>
          {s.query}
        </Button>
      )}
      {conflict && !denied && (
        <Button loading={refreshing} onClick={() => void flow.refreshContext()}>
          {s.refresh}
        </Button>
      )}
      {!taskId && !unknown && (
        <Button type="primary" disabled={!canSend} loading={form.busy} onClick={flow.confirm}>
          {s.confirm}
        </Button>
      )}
    </>
  );
}

function SourceTemplateFields({ flow }: { flow: SourceFlow }) {
  const { context, conflict, options, ids, form } = flow;
  if (context.data?.canInitiate === false) return <p role="alert">{context.data.reason}</p>;
  return (
    <>
      <p>
        {s.templateSnapshot} {s.variableGrant}
      </p>
      <p>{s.repeat}</p>
      <TemplatePicker
        options={options}
        value={ids}
        disabled={form.busy || conflict}
        emptyText={s.emptyTemplates}
        max={SOURCE_TEMPLATE_LIMIT}
        onChange={flow.setIds}
      />
      {!!context.error && !conflict && <Button onClick={context.refresh}>{s.retry}</Button>}
    </>
  );
}

function CommandFeedback({ flow }: { flow: SourceFlow }) {
  const { form, conflict, denied, unknown, error, readError, variableDenied } = flow;
  return (
    <>
      {form.busy && <p role="status">{s.sending}</p>}
      {conflict && !denied && (
        <p role="alert">
          {rejectionMessage(error)} {s.conflict}
        </p>
      )}
      {conflict && !!readError && !denied && <p role="alert">{m.picker.failed(rejectionMessage(readError))}</p>}
      {form.status === 'rejected' && !!error && !denied && !conflict && (
        <p role="alert">{variableDenied ? s.variableDenied : rejectionMessage(error)}</p>
      )}
      {unknown && <p role="alert">{denied ? s.stopped : s.unknown}</p>}
      {unknown && form.state?.reading && <p role="status">{s.checking}</p>}
      {unknown && !!readError && !denied && <p role="alert">{s.queryFailed}</p>}
    </>
  );
}

function SubmittedTask({ id, onRead }: { id: string; onRead(id: string): void }) {
  const read = useRead<unknown>(minePath(id));
  useTasksChanged(read.refresh, id);
  let task;
  let error = read.error;
  try {
    if (read.data !== undefined) {
      task = parseMineDetail(read.data);
      if (task.id !== id || typeof task.status !== 'string') throw new Error(s.invalidReceipt);
    }
  } catch (cause) {
    error = cause;
  }
  const observed = !!task && !error;
  useEffect(() => {
    if (observed) onRead(id);
  }, [id, observed, onRead]);

  if (error)
    return (
      <div role="alert">
        {s.statusFailed}
        {!unreadable(error) && <Button onClick={read.refresh}>{s.retryStatus}</Button>}
      </div>
    );
  if (!task) return <p role="status">{s.submitted}</p>;
  const status = sourceStatus(task.status, task.currentNode);
  if (task.status === 'failed')
    return <p role="alert">{m.reissue.failed(esignFailureText(task.failureReason ?? null) ?? s.failureUnknown)}</p>;
  return <p role="status">{status}</p>;
}
