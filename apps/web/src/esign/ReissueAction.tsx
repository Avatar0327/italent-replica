// F-481 §8.1：任职记录列表「调动发起电子签署」补发。按钮权 MulLaunchESignTranfer（列表级）+ 任职记录修改权，
// 与 task-routes.ts 的授权一致；勾选里非调动的行不预先过滤，由后端逐条回执说明（总编排补充 3）。
// 命令按 DEC-067：同一次尝试固定命令 ID 与报文；结果未知时锁定，只能由用户显式“按原命令重发”。
import { App, Button, Modal, Table } from 'antd';
import { useState } from 'react';
import { ApiError, newCommand, rejectionMessage, type Command } from '../foundation/client.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
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

export interface ReissueRow {
  readonly id: string;
  readonly employeeName?: string;
}
type Attempt =
  | { status: 'sending' | 'rejected' | 'unknown'; command: Command<ReissueBody>; error?: unknown }
  | { status: 'done'; command: Command<ReissueBody>; receipts: ReissueReceipt[] };

/** 网络中断、5xx、回执无法识别：服务端可能已处理，不能当作失败另起命令。 */
const uncertain = (error: unknown) => !(error instanceof ApiError) || error.kind === 'unknown';

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
  const [ids, setIds] = useState<string[]>([]);
  const [attempt, setAttempt] = useState<Attempt>();
  const chosen = chosenTemplates(options, ids);
  const locked = !!attempt && attempt.status !== 'rejected';
  const send = async (command: Command<ReissueBody>) => {
    setAttempt({ status: 'sending', command });
    try {
      const raw = await api.request<unknown>(TRANSFER_TASKS_PATH, { method: 'POST', command });
      setAttempt({ status: 'done', command, receipts: parseReissueReceipts(raw, command.body) });
    } catch (error) {
      setAttempt({ status: uncertain(error) ? 'unknown' : 'rejected', command, error });
      // 被拒（如模板刚被停用）后重读选项，已不可用的模板不再计入可提交的选择。
      if (!uncertain(error)) options.refresh?.();
    }
  };
  const submit = () =>
    void send(newCommand({ items: rows.map((row) => ({ businessId: row.id })), templateIds: chosen }));
  const footer = [
    <Button key="close" onClick={close}>
      {r.close}
    </Button>,
    attempt?.status === 'unknown' && (
      <Button key="replay" onClick={() => void send(attempt.command)}>
        {r.replay}
      </Button>
    ),
    <Button key="confirm" type="primary" disabled={locked || !chosen.length} onClick={submit}>
      {r.confirm}
    </Button>,
  ];
  return (
    <Modal open title={r.title} onCancel={close} maskClosable={false} footer={footer}>
      <p>{r.selected(rows.length)}</p>
      <TemplatePicker options={options} value={ids} disabled={locked} onChange={setIds} />
      {attempt?.status === 'rejected' && <p role="alert">{rejectionMessage(attempt.error)}</p>}
      {attempt?.status === 'unknown' && (
        <p role="alert">{attempt.error instanceof ApiError ? r.unknown : `${r.invalidReceipt}；${r.unknown}`}</p>
      )}
      {attempt?.status === 'done' && <Receipts rows={rows} receipts={attempt.receipts} />}
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
