// F-481 §8.3：我的签署。电子签 > 我的签署 与 员工自助 > 我的签署 挂同一个组件、读同一接口（只列本人的签署任务，
// 后端按本人过滤，前端不另判权限）。两页签 待我签署 / 我已签署；详情逐份显示正文快照与两节点进度。
// 确认签署走 F-142 冲突恢复内核（useConflictCommand）：请求期间按钮禁用；409 只提示并刷新详情，不自动重提；
// 结果未知钉住恢复槽，按 GET /mine/:id 回查并锁定，只能显式按原命令重发（claude_fe_rules g，DEC-067）。
import { App, Button, Space, Tabs, type TableColumnsType } from 'antd';
import { useEffect, useState } from 'react';
import { useRead } from '../contracts/useRead.js';
import { pageQuery, rejectionMessage, type PageRequest } from '../foundation/client.js';
import { PageState } from '../foundation/PageState.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { useConflictCommand, type Sending } from '../foundation/forms/ConflictCommands.js';
import { createFormStore } from '../foundation/forms/store.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { DetailPage, ListPage } from '../foundation/templates.js';
import { dateTime } from '../talent-review/ConfigList.js';
import { useESignDownload } from './download.js';
import './esign.css';
import { m } from './messages.js';
import {
  MINE_PATH,
  MINE_TABS,
  mineFilesPath,
  minePath,
  parseMine,
  parseMineDetail,
  parseSignReceipt,
  signPath,
  snapshotOf,
  type MineRow,
  type MineTab,
} from './mine-model.js';
import { fileText, nameText, sceneText, statusText, unknownText } from './sign-model.js';
import { tasksChanged, useTasksChanged } from './task-changes.js';

const t = m.mine;
// 模块级：结果未知的签署在切走菜单、关闭详情再回来时仍锁定（同 TemplatesPage）。
const store = createFormStore();

export function MySignPage() {
  return (
    <div className="esign-mine">
      <FormCommands store={store}>
        <MineList />
      </FormCommands>
    </div>
  );
}

function MineList() {
  const { timezone } = useSession();
  const [tab, setTab] = useState<MineTab>('pending');
  const [page, setPage] = useState<PageRequest>({ page: 1, pageSize: 20 });
  // seq 让每次打开都是新的详情组件：关闭前未返回的旧读取随组件中止，迟到也不会落到重开后的详情上。
  const [opened, setOpened] = useState<{ id: string; seq: number }>();
  const read = useRead<unknown>(`${MINE_PATH}?tab=${tab}&${pageQuery(page, 'offset')}`);
  useTasksChanged(read.refresh);
  let items: MineRow[] = [];
  let error = read.error;
  try {
    if (read.data !== undefined) items = parseMine(read.data);
  } catch (cause) {
    error = cause;
  }
  const show = (id: string) => setOpened({ id, seq: (opened?.seq ?? 0) + 1 });
  const columns: TableColumnsType<MineRow> = [
    {
      key: 'scene',
      title: t.scene,
      render: (_, row) => (
        <Button type="link" size="small" onClick={() => show(row.id)}>
          {sceneText(row.scene)}
        </Button>
      ),
    },
    { key: 'initiator', title: t.initiator, render: (_, row) => nameText(row.initiator) },
    { key: 'initiatedAt', title: t.initiatedAt, render: (_, row) => dateTime(row.initiatedAt, timezone) },
    { key: 'expiresAt', title: t.expiresAt, render: (_, row) => dateTime(row.expiresAt, timezone) },
    { key: 'files', title: t.files, render: (_, row) => fileText(row.files?.map((item) => item.templateName) ?? []) },
    { key: 'status', title: t.status, render: (_, row) => statusText(row.status, row.currentNode) },
  ];
  return (
    <>
      <ListPage<MineRow>
        title={t.title}
        data={{ items }}
        columns={columns}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        loading={!error && read.loading}
        error={error}
        retry={read.refresh}
        exportAction={null}
        filters={
          <Tabs
            activeKey={tab}
            onChange={(next) => {
              setTab(next as MineTab);
              setPage({ ...page, page: 1 });
            }}
            items={MINE_TABS.map((key) => ({ key, label: t.tabs[key] }))}
          />
        }
      />
      {opened && <MineDetail key={opened.seq} id={opened.id} close={() => setOpened(undefined)} />}
    </>
  );
}

function MineDetail({ id, close }: { id: string; close(): void }) {
  const read = useRead<unknown>(minePath(id));
  // 签署结果可能落在已关闭的上一个详情上：当前打开的同任务详情按任务 ID 收通知重读（返工 P2-1）。
  useTasksChanged(read.refresh, id);
  let row: MineRow | undefined;
  let error = read.error;
  try {
    if (read.data !== undefined) row = parseMineDetail(read.data);
  } catch (cause) {
    error = cause;
  }
  let body = <PageState kind="loading" />;
  if (error) body = <PageState kind="error" error={error} retry={read.refresh} />;
  else if (row && !read.loading) body = <SignBody row={row} />;
  return <DetailPage open title={t.detail} onClose={close} summary={body} />;
}

function SignBody({ row }: { row: MineRow }) {
  const api = useApiClient();
  const { message } = App.useApp();
  const { timezone } = useSession();
  const download = useESignDownload();
  const recheck = async () => snapshotOf(parseMineDetail(await api.request<unknown>(minePath(row.id))));
  const { form, run, replay } = useConflictCommand(MINE_PATH, snapshotOf(row), recheck, { action: 'sign' });
  const state = form.state;
  const unknown = form.status === 'unknown';
  // 打开详情时若上次结果未知，先按原单回查一次（读到的状态只作提示，不解锁、不另起命令）。
  useEffect(() => {
    if (form.peek()?.status === 'unknown') void form.reload?.();
  }, []);
  // 请求体就是命令体 { revision }；不带 If-Match（后端从请求体取版本，同 signMine）。
  const send = ({ command }: Sending) =>
    api
      .request<unknown>(signPath(row.id), { method: 'POST', command: { id: command.id, body: command.body } })
      .then((receipt) => parseSignReceipt(receipt, row.id));
  // 落定时本详情可能已关闭：刷新交给仍挂着的列表与同任务详情，不调本组件的读取。
  const refresh = () => tasksChanged([row.id]);
  const finish = () => {
    void message.success(t.signed);
    refresh();
  };
  const fail = (failure: unknown) => {
    if (form.peek()?.status === 'unknown') return void form.reload?.();
    void message.error(rejectionMessage(failure));
    // 被拒的尝试已确认失败，不再占着条目；冲突由内核留在旧版本上，刷新后按新版本是新条目。
    if (form.peek()?.status === 'rejected') form.clear();
    refresh();
  };
  const sign = () => run({ values: { revision: row.revision }, editableFields: ['revision'], send }).then(finish, fail);
  const resend = () => replay(send).then(finish, fail);
  const signable = row.canSign === true || form.locked;
  const latest = state?.latest?.values;
  // 回查中 > 回查失败 > 回查到的状态（后赋值的优先）
  let recheckText = latest && t.rechecked(statusText(latest.status, latest.currentNode));
  if (state?.readError) recheckText = t.recheckFailed;
  if (state?.reading) recheckText = t.rechecking;
  return (
    <>
      <Space wrap>
        <span>{statusText(row.status, row.currentNode)}</span>
        {signable && (
          <Button type="primary" disabled={form.locked} onClick={() => void sign()}>
            {t.sign}
          </Button>
        )}
        {row.status === 'completed' && (
          <Button onClick={() => void download(mineFilesPath(row.id))}>{t.download}</Button>
        )}
      </Space>
      {signable && !form.locked && <p>{t.simulated}</p>}
      {unknown && (
        <div role="alert">
          <p>{unknownText(state?.error, t.invalidReceipt)}</p>
          {recheckText && <p>{recheckText}</p>}
          <Button onClick={() => void resend()}>{t.replay}</Button>
        </div>
      )}
      <section className="detail-section">
        <h2>{t.progress}</h2>
        <p>{t.node(t.nodes.employee, row.employeeSignedAt ? dateTime(row.employeeSignedAt, timezone) : t.waiting)}</p>
        <p>
          {t.node(t.nodes.enterprise, row.enterpriseSignedAt ? dateTime(row.enterpriseSignedAt, timezone) : t.waiting)}
        </p>
      </section>
      <section className="detail-section">
        <h2>{t.documents}</h2>
        {row.files?.map((item) => (
          <article key={item.seq}>
            <h3>{item.templateName ?? m.missing}</h3>
            <p className="esign-content">{item.content ?? m.missing}</p>
          </article>
        ))}
      </section>
    </>
  );
}
