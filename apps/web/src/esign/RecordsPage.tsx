// F-481 §8.2：电子签 > 签署记录。三页签、8 列；提醒 / 撤销 / 下载文件作用于勾选行，按 ESignRecord.*（列表级）放行，
// 没有“电子文件”读权时该列与「下载文件」都不显示（总编排补充 3）。
// 提醒 / 撤销走 F-147 批量内核（useBatchCommand + forAction）：勾选行的恢复槽钉到本次命令，结果未知时关闭重开、
// 换一批勾选（含未确认行）、换动作都仍锁定，只能显式按原命令重发；回执逐条转中文，409 REVISION_CONFLICT 只提示刷新，
// 不自动重提（claude_fe_rules g，DEC-067）。
import { esignFailureText } from '@italent/domain';
import { App, Button, Modal, Table, Tabs, Tooltip, type TableColumnsType } from 'antd';
import { useState } from 'react';
import { useRead } from '../contracts/useRead.js';
import { pageQuery, rejectionMessage, type Command, type PageRequest } from '../foundation/client.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { forAction } from '../foundation/forms/action.js';
import { createFormStore, type Values } from '../foundation/forms/store.js';
import { useBatchCommand, type CommandForm } from '../foundation/forms/useCommandForm.js';
import { ListPage } from '../foundation/templates.js';
import { dateTime } from '../talent-review/ConfigList.js';
import { useESignDownload } from './download.js';
import { m } from './messages.js';
import {
  RECORDS_PATH,
  RECORD_BUTTONS,
  RECORD_OBJECT,
  RECORD_TABS,
  filesPath,
  parseRecordReceipts,
  parseRecords,
  receiptText,
  type RecordAction,
  type RecordBody,
  type RecordReceipt,
  type RecordRow,
  type RecordTab,
} from './records-model.js';
import { fileText, nameText, sceneText, statusText, unknownText } from './sign-model.js';

const t = m.records;
// 模块级：切走菜单再回来，结果未知的提醒 / 撤销仍锁定（同 ReissueAction）。
const store = createFormStore();
// 回执按命令 ID 存，弹窗只显示内核当前命令（done）对应的那份；状态仍只看内核存储，关闭弹窗时删掉已确认命令的回执。
const receiptsOf = new Map<string, RecordReceipt[]>();
type Api = ReturnType<typeof useApiClient>;
interface Dialog {
  readonly action: RecordAction;
  readonly rows: readonly RecordRow[];
  /** 撤销先确认；提醒、或撤销已在途 / 结果未知时直接看结果 */
  readonly asking: boolean;
}

/** 批量命令没有对象版本：版本逐条放在请求体里，不带 If-Match。回执识别不了按结果未知处理。 */
async function deliver(api: Api, action: RecordAction, command: Command<Values>) {
  const body = command.body as unknown as RecordBody;
  const raw = await api.request<unknown>(`${RECORDS_PATH}/${action}`, {
    method: 'POST',
    command: { id: command.id, body },
  });
  receiptsOf.set(command.id, parseRecordReceipts(raw, body));
  return { id: command.id };
}
function submitTo(api: Api, command: CommandForm, action: RecordAction, rows: readonly RecordRow[]) {
  // 已确认的上一次结果（完成、被拒）不挡新命令；未确认的由内核原样返回、不另起命令。
  if (command.status === 'rejected' || command.status === 'done') command.clear();
  const values = { items: rows.map((row) => ({ id: row.id, revision: row.revision })) };
  const send = (request: Command<Values>) => deliver(api, action, request);
  return command.submit({ values, baseline: {}, editableFields: ['items'], revision: 0, send });
}

export function RecordsPage() {
  return (
    <div className="esign-records">
      <RecordList />
    </div>
  );
}

function RecordList() {
  const permission = usePermissions(RECORD_OBJECT);
  const loaded = permission.snapshot.objects[RECORD_OBJECT];
  const ready = !!loaded && !loaded.summary;
  const { message } = App.useApp();
  const { timezone } = useSession();
  const download = useESignDownload();
  const [tab, setTab] = useState<RecordTab>('all');
  // 每页最多 50 条：勾选不超过提醒 / 撤销 / 下载的每批上限（record-routes.ts checkIds）
  const [page, setPage] = useState<PageRequest>({ page: 1, pageSize: 20 });
  const [selected, setSelected] = useState<readonly RecordRow[]>([]);
  const records = useRecords(tab, page);
  const error = records.error ?? permission.error;
  const finish = () => {
    setSelected([]);
    records.read.refresh();
  };
  const { act, dialog } = useRecordActions(selected, finish);
  const can = (button: keyof typeof RECORD_BUTTONS) => ready && permission.can(RECORD_BUTTONS[button], 'list');
  const canDownload = can('download') && permission.field('files').visible;
  const downloadSelected = () => {
    if (!selected.length) return void message.warning(t.noSelection);
    void download(filesPath(selected.map((row) => row.id)));
  };
  const switchTab = (next: string) => {
    setTab(next as RecordTab);
    setPage({ ...page, page: 1 });
    setSelected([]);
  };
  const columns = recordColumns(timezone, canDownload ? download : undefined);
  const keys = selected.map((row) => row.id);
  const anyAction = can('remind') || can('revoke') || canDownload;
  return (
    <>
      <ListPage<RecordRow>
        title={t.title}
        data={records.data}
        columns={columns.filter((column) => permission.field(String(column.key)).visible)}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        pageSizes={[20, 50]}
        loading={!error && (records.read.loading || !ready)}
        error={error}
        retry={records.read.refresh}
        exportAction={null}
        filters={
          <Tabs activeKey={tab} onChange={switchTab} items={RECORD_TABS.map((key) => ({ key, label: t.tabs[key] }))} />
        }
        actions={
          <>
            {can('remind') && <Button onClick={() => act('remind')}>{t.actions.remind}</Button>}
            {can('revoke') && <Button onClick={() => act('revoke')}>{t.actions.revoke}</Button>}
            {canDownload && <Button onClick={downloadSelected}>{t.download}</Button>}
          </>
        }
        selection={anyAction ? { keys, onChange: (_, rows) => setSelected(rows), actions: null } : undefined}
      />
      {dialog}
    </>
  );
}

function useRecords(tab: RecordTab, page: PageRequest) {
  const read = useRead<unknown>(`${RECORDS_PATH}?tab=${tab}&${pageQuery(page)}`);
  const empty = { items: [] as RecordRow[], total: 0 };
  try {
    return { read, data: read.data === undefined ? empty : parseRecords(read.data), error: read.error };
  } catch (cause) {
    return { read, data: empty, error: cause };
  }
}

/** 页面级的提醒 / 撤销：勾选行的恢复槽上有别的动作未确认时拒绝（blocked），提醒直接提交，撤销先确认。 */
function useRecordActions(selected: readonly RecordRow[], done: () => void) {
  const api = useApiClient();
  const { message } = App.useApp();
  const [dialog, setDialog] = useState<Dialog>();
  const batch: CommandForm = useBatchCommand(
    RECORDS_PATH,
    selected.map((row) => row.id),
    store,
  );
  const act = (action: RecordAction) => {
    if (!selected.length) return void message.warning(t.noSelection);
    const command = forAction(batch, { action });
    if (command.blocked) return void message.warning(t.blocked);
    if (action === 'remind' && !command.locked) void submitTo(api, command, action, selected);
    setDialog({ action, rows: selected, asking: action === 'revoke' && !command.locked });
  };
  const finish = () => {
    setDialog(undefined);
    done();
  };
  const view = dialog && <RecordDialog {...dialog} cancel={() => setDialog(undefined)} finish={finish} />;
  return { act, dialog: view };
}

/** 8 列（§8.2）；电子文件在已完成且可下载时是链接，点了下载这一行的文件。 */
function recordColumns(timezone: string, download?: (path: string) => void): TableColumnsType<RecordRow> {
  const fileCell = (row: RecordRow) => {
    const text = fileText(row.files?.map((item) => item.name) ?? []);
    if (row.status !== 'completed' || !download || !row.files?.length) return text;
    return (
      <Button type="link" size="small" onClick={() => download(filesPath([row.id]))}>
        {text}
      </Button>
    );
  };
  return [
    { key: 'initiator', title: t.initiator, render: (_, row) => nameText(row.initiator) },
    { key: 'owner', title: t.owner, render: (_, row) => nameText(row.owner) },
    { key: 'ownerDepartment', title: t.ownerDepartment, render: (_, row) => nameText(row.ownerDepartment) },
    { key: 'scene', title: t.scene, render: (_, row) => sceneText(row.scene) },
    { key: 'initiatedAt', title: t.initiatedAt, render: (_, row) => dateTime(row.initiatedAt, timezone) },
    { key: 'completedAt', title: t.completedAt, render: (_, row) => dateTime(row.completedAt, timezone) },
    { key: 'status', title: t.status, render: (_, row) => <StatusCell row={row} /> },
    { key: 'files', title: t.files, render: (_, row) => fileCell(row) },
  ];
}

function StatusCell({ row }: { row: RecordRow }) {
  const text = <span>{statusText(row.status, row.currentNode)}</span>;
  const reason = row.status === 'failed' ? esignFailureText(row.failureReason ?? null) : null;
  return reason ? <Tooltip title={reason}>{text}</Tooltip> : text;
}

function RecordDialog({ action, rows, asking, cancel, finish }: Dialog & { cancel(): void; finish(): void }) {
  const api = useApiClient();
  const ids = rows.map((row) => row.id);
  const batch: CommandForm = useBatchCommand(RECORDS_PATH, ids, store);
  const command = forAction(batch, { action });
  const [confirming, setConfirming] = useState(asking);
  const state = command.state;
  const receipts = state?.status === 'done' && state.command ? receiptsOf.get(state.command.id) : undefined;
  const confirm = () => {
    setConfirming(false);
    void submitTo(api, command, action, rows);
  };
  const close = () => {
    if (!command.locked && state?.command) receiptsOf.delete(state.command.id);
    if (!command.locked) command.clear();
    finish();
  };
  const footer = confirming
    ? [
        <Button key="cancel" onClick={cancel}>
          {t.cancel}
        </Button>,
        <Button key="confirm" type="primary" danger onClick={confirm}>
          {t.confirm}
        </Button>,
      ]
    : [
        command.status === 'unknown' && (
          <Button key="replay" onClick={() => void command.replay((request) => deliver(api, action, request))}>
            {t.replay}
          </Button>
        ),
        <Button key="close" onClick={close}>
          {t.close}
        </Button>,
      ];
  return (
    <Modal open title={t.actions[action]} onCancel={confirming ? cancel : close} maskClosable={false} footer={footer}>
      {confirming && <p>{t.revokeConfirm}</p>}
      {!confirming && command.status === 'submitting' && <p>{t.sending}</p>}
      {!confirming && command.status === 'unknown' && <p role="alert">{unknownText(state?.error, t.invalidReceipt)}</p>}
      {!confirming && ['rejected', 'conflict'].includes(command.status) && (
        <p role="alert">{rejectionMessage(state?.error)}</p>
      )}
      {!confirming && receipts && <Receipts action={action} rows={rows} receipts={receipts} />}
    </Modal>
  );
}

function Receipts(props: { action: RecordAction; rows: readonly RecordRow[]; receipts: readonly RecordReceipt[] }) {
  const owner = (id: string) => nameText(props.rows.find((row) => row.id === id)?.owner);
  return (
    <Table<RecordReceipt>
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={[...props.receipts]}
      columns={[
        { key: 'owner', title: t.owner, render: (_, item) => owner(item.id) },
        { key: 'result', title: t.result, render: (_, item) => receiptText(item, props.action) },
      ]}
    />
  );
}
