// F-481 §8.1：任职记录列表「调动发起电子签署」补发。按钮权 MulLaunchESignTranfer（列表级）+ 任职记录修改权，
// 与 task-routes.ts 的授权一致；勾选里非调动的行不预先过滤，由后端逐条回执说明（总编排补充 3）。
// 命令走 F-147 批量内核（useBatchCommand）：每条任职记录的恢复槽钉到本次命令，结果未知时关闭重开、
// 换一批勾选（含未确认行）仍锁定，只能由用户显式“按原命令重发”（claude_fe_rules g，DEC-067）。
import { App, Button, Modal, Table } from 'antd';
import { useEffect, useState } from 'react';
import { ApiError, rejectionMessage, type Command } from '../foundation/client.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { createFormStore, isLocked, type Values } from '../foundation/forms/store.js';
import { useBatchCommand } from '../foundation/forms/useCommandForm.js';
import { RECORD_OBJECT } from '../employment-records/model.js';
import { m } from './messages.js';
import { REISSUE_OPTIONS_PATH, TRANSFER_TASKS_PATH } from './model.js';
import {
  REISSUE_LIMIT,
  parseReissueReceipts,
  receiptText,
  type ReissueBody,
  type ReissueReceipt,
} from './reissue-model.js';
import { TemplatePicker, chosenTemplates, useTemplateOptions } from './TemplatePicker.js';

const REISSUE_BUTTON = 'MulLaunchESignTranfer';
const r = m.reissue;
// 模块级：切走列表再回来，结果未知的补发仍锁定（同 TemplatesPage）。
const store = createFormStore();
// 回执按命令 ID 存：弹窗在请求途中被关掉时，重开的弹窗仍能显示这次命令的结果。状态仍只看内核存储。
const receiptsOf = new Map<string, ReissueReceipt[]>();
// 弹窗消失（关闭或离开页面）时仍在途 / 结果未知的命令：之后才到的回执、拒绝原因留到重开同一批时显示。
const detached = new Set<string>();

export interface ReissueRow {
  readonly id: string;
  readonly employeeName?: string;
}
type Api = ReturnType<typeof useApiClient>;

/** 补发是新建任务、没有版本：不带 If-Match。回执识别不了按结果未知处理（内核把非 HTTP 错误记为 unknown）。 */
async function deliver(api: Api, command: Command<Values>) {
  const body = command.body as unknown as ReissueBody;
  const raw = await api.request<unknown>(TRANSFER_TASKS_PATH, { method: 'POST', command: { id: command.id, body } });
  receiptsOf.set(command.id, parseReissueReceipts(raw, body));
  return { id: command.id };
}
const templatesOf = (command?: Command<Values>) => {
  const ids = command?.body.templateIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
};

export function ReissueAction({ selected }: { selected: readonly ReissueRow[] }) {
  const permission = usePermissions(RECORD_OBJECT);
  const { message } = App.useApp();
  const [rows, setRows] = useState<readonly ReissueRow[]>();
  const update = permission.snapshot.objects[RECORD_OBJECT]?.dataOperations.update === true;
  if (!permission.can(REISSUE_BUTTON, 'list') || !update) return null;
  const open = () => {
    if (!selected.length) return void message.warning(r.noSelection);
    if (selected.length > REISSUE_LIMIT) return void message.warning(r.tooMany(REISSUE_LIMIT));
    setRows(selected);
  };
  return (
    <>
      <Button onClick={open}>{r.action}</Button>
      {rows && <ReissueDialog rows={rows} close={() => setRows(undefined)} />}
    </>
  );
}

function ReissueDialog({ rows, close }: { rows: readonly ReissueRow[]; close(): void }) {
  const api = useApiClient();
  const options = useTemplateOptions(REISSUE_OPTIONS_PATH);
  const form = useBatchCommand(
    TRANSFER_TASKS_PATH,
    rows.map((row) => row.id),
    store,
  );
  const [ids, setIds] = useState<string[]>([]);
  // 本弹窗跟进的命令：打开时在途、结果未知或途中离开后才有结果的那条，或本弹窗发出的。看过的结果不再显示。
  const [watched, setWatched] = useState(() => {
    const id = form.state?.command?.id;
    return id && (form.locked || detached.has(id)) ? id : undefined;
  });
  // 只登记不清存储：StrictMode 的模拟卸载也走这里，按卸载那一刻的状态记入或移出。
  useEffect(() => () => {
    const state = form.peek();
    const id = state?.command?.id;
    if (id && isLocked(state)) detached.add(id);
    else if (id) detached.delete(id);
  });
  const receipts = watched ? receiptsOf.get(watched) : undefined;
  const pending = form.locked ? form.state : undefined;
  const rejected = form.status === 'rejected' && form.state?.command?.id === watched ? form.state : undefined;
  const chosen = chosenTemplates(options, ids);
  const frozen = form.locked || !!receipts;
  const send = (command: Command<Values>) => {
    setWatched(command.id);
    return deliver(api, command);
  };
  const submit = async () => {
    // 已确认的上一次结果（完成、被拒）不挡新命令；未确认的由内核原样返回、不另起命令。
    if (form.status === 'rejected' || form.status === 'done') form.clear();
    const values = { items: rows.map((row) => ({ businessId: row.id })), templateIds: chosen };
    const result = await form.submit({ values, baseline: {}, editableFields: Object.keys(values), revision: 0, send });
    // 被拒（如模板刚被停用）后重读选项，已不可用的模板不再计入可提交的选择。
    if (result.status === 'rejected') options.refresh?.();
  };
  const dismiss = () => {
    if (!form.locked) form.clear();
    if (watched && !form.locked) receiptsOf.delete(watched);
    close();
  };
  const footer = [
    <Button key="close" onClick={dismiss}>
      {r.close}
    </Button>,
    pending?.status === 'unknown' && (
      <Button key="replay" onClick={() => void form.replay(send)}>
        {r.replay}
      </Button>
    ),
    <Button key="confirm" type="primary" disabled={frozen || !chosen.length} onClick={() => void submit()}>
      {r.confirm}
    </Button>,
  ];
  return (
    <Modal open title={r.title} onCancel={dismiss} maskClosable={false} footer={footer}>
      <p>{r.selected(rows.length)}</p>
      <TemplatePicker
        options={options}
        value={pending ? templatesOf(pending.command) : ids}
        disabled={frozen}
        onChange={setIds}
      />
      {rejected && <p role="alert">{rejectionMessage(rejected.error)}</p>}
      {pending?.status === 'unknown' && (
        <p role="alert">{pending.error instanceof ApiError ? r.unknown : `${r.invalidReceipt}；${r.unknown}`}</p>
      )}
      {receipts && <Receipts rows={rows} receipts={receipts} />}
    </Modal>
  );
}

function Receipts({ rows, receipts }: { rows: readonly ReissueRow[]; receipts: readonly ReissueReceipt[] }) {
  const name = (id: string) => rows.find((row) => row.id === id)?.employeeName ?? m.missing;
  return (
    <Table<ReissueReceipt>
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={[...receipts]}
      columns={[
        { key: 'person', title: r.person, render: (_: unknown, item: ReissueReceipt) => name(item.id) },
        { key: 'result', title: r.result, render: (_: unknown, item: ReissueReceipt) => receiptText(item) },
      ]}
    />
  );
}
