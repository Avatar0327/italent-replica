import { Alert, App, Button, Empty, Modal, Popconfirm, Space, Spin, Tooltip } from 'antd';
import { useState } from 'react';
import { useHref } from 'react-router';
import { ApiError, PageState, useApiClient, useSession, type ListView } from '../foundation/index.js';
import { ViewHeading } from '../foundation/ViewHeading.js';
import { ui } from '../foundation/messages.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Command } from '../foundation/client.js';
import type { Submission, Values } from '../foundation/forms/store.js';
import { useRemote, type PageAccess } from '../org/page-support.js';
import { GRAPH_ID, GRAPH_PATH, ISSUES_SEARCH, graphGrid, graphTime, type GraphSnapshot } from './graph-model.js';
import { graphText as t, pageText as m, text } from './messages.js';
import './job-graph.css';

/** 明确拒绝按机器码给文案（设计 §5），不展示服务端原文；未映射的用原站兜底。 */
function rejectionText(error: unknown) {
  if (!(error instanceof ApiError)) return t.failed;
  if (error.status === 409 && error.code === 'CONFLICT') return t.busy;
  if (error.status === 400 && error.code === 'VALIDATION_FAILED') return t.tooLarge;
  if (error.status === 403) return t.denied;
  return t.failed;
}
const isSnapshot = (value: unknown): value is GraphSnapshot =>
  !!value && Number.isSafeInteger((value as GraphSnapshot).revision) && !!(value as GraphSnapshot).layout;

/**
 * 重新生成走 F-123 命令内核（DEC-464 / DEC-473）：结果未知时锁定、只能按原命令重放；
 * 409 REVISION_CONFLICT 重读最新快照后放开，下一次是新命令、带新 revision（DEC-896 U6）。
 */
function useRebuild(current: GraphSnapshot | null, show: (snapshot: GraphSnapshot, fresh: boolean) => void) {
  const api = useApiClient();
  const { message } = App.useApp();
  const command = useCommandForm(slotKey(GRAPH_PATH));
  const send = async (next: Command<Values>) => {
    const built = await api.request<unknown>(`${GRAPH_PATH}/rebuild`, { method: 'POST', command: next });
    // 回执外形不对就当结果未知：不能据此判定成功，也不能另起命令。
    if (!isSnapshot(built)) throw new Error(t.uncertain);
    show(built, true);
    return { id: GRAPH_ID };
  };
  const read = async () => {
    const data = await api.request<{ snapshot: GraphSnapshot | null }>(GRAPH_PATH);
    if (data.snapshot) show(data.snapshot, false);
    return { id: GRAPH_ID, revision: data.snapshot?.revision ?? 0, values: {} };
  };
  const reread = async () => {
    await command.reread(read);
    if (command.peek()?.readError) return;
    command.confirm();
    command.clear();
  };
  const settle = async (result: Submission | undefined, refresh: () => void) => {
    if (!result) return;
    if (result.status === 'done') command.clear();
    if (result.status === 'conflict') {
      void message.warning(t.updatedByOthers);
      await reread();
    }
    if (result.status === 'rejected') {
      const busy = rejectionText(result.error) === t.busy;
      void message[busy ? 'warning' : 'error'](rejectionText(result.error));
      command.clear();
      if (busy) refresh();
    }
  };
  return {
    command,
    reread,
    async start(refresh: () => void) {
      command.clear();
      const result = await command.submit({
        values: {},
        baseline: {},
        editableFields: [],
        revision: current?.revision ?? 0,
        businessId: GRAPH_ID,
        send,
      });
      await settle(result, refresh);
    },
    async replay(refresh: () => void) {
      await settle(await command.replay(send), refresh);
    },
  };
}

export function JobGraph({ access, view }: { access: PageAccess; view: ListView }) {
  const session = useSession();
  const remote = useRemote<{ snapshot: GraphSnapshot | null }>(GRAPH_PATH);
  // 重新生成 / 重读拿到的快照优先于首屏读取；刷新时丢弃，以服务端为准。按会话（租户 + 身份）隔离，换身份不沿用。
  const context = `${session.tenantId}/${session.identityKey}`;
  const [held, setShown] = useState<{ context: string; snapshot: GraphSnapshot }>();
  const [notice, setNotice] = useState(false);
  const shown = held?.context === context ? held.snapshot : undefined;
  const current = shown ?? remote.data?.snapshot ?? null;
  const rebuild = useRebuild(current, (snapshot, fresh) => {
    setShown({ context, snapshot });
    if (fresh && snapshot.containsError) setNotice(true);
  });
  const refresh = () => {
    setShown(undefined);
    remote.refresh();
  };
  const heading = (
    <header className="page-heading">
      <ViewHeading title={t.title} view={view} />
      {!remote.error && (
        <Toolbar snapshot={current} access={access} rebuild={rebuild} refresh={refresh} ready={!remote.loading} />
      )}
    </header>
  );
  let body;
  if (remote.error)
    body = (
      <PageState
        kind={remote.error instanceof ApiError && remote.error.status === 403 ? 'forbidden' : 'error'}
        error={remote.error}
        retry={refresh}
      />
    );
  else if (remote.loading && !shown) body = <PageState kind="loading" />;
  else body = <GraphBody snapshot={current} access={access} />;
  return (
    <section className="list-page job-graph">
      {heading}
      <CommandNotice rebuild={rebuild} refresh={refresh} />
      <div className="list-card">{body}</div>
      {rebuild.command.busy && (
        <div className="job-graph-mask" role="status">
          <Spin />
          <span>{t.generating}</span>
        </div>
      )}
      {notice && <IssuesModal onClose={() => setNotice(false)} />}
    </section>
  );
}
type Rebuild = ReturnType<typeof useRebuild>;

function Toolbar(props: {
  snapshot: GraphSnapshot | null;
  access: PageAccess;
  rebuild: Rebuild;
  refresh: () => void;
  ready: boolean;
}) {
  const { snapshot, access, rebuild, refresh, ready } = props;
  const session = useSession();
  const issues = useHref({ search: ISSUES_SEARCH });
  return (
    <Space className="job-graph-toolbar">
      {snapshot && (
        <span className="job-graph-time">
          {t.generatedAt}
          {graphTime(snapshot.generatedAt, session.timezone)}
        </span>
      )}
      {snapshot?.containsError && (
        <Tooltip title={t.issuesHint}>
          <a
            className="job-graph-warning"
            href={issues}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t.issuesHint}
          >
            <WarningIcon />
          </a>
        </Tooltip>
      )}
      {access.can('export', 'list') && (
        // 导出属 F-474-7c：本期按列表页同样的禁用占位，不发请求。
        <Tooltip title={ui.exportPending}>
          <Button disabled>{ui.export}</Button>
        </Tooltip>
      )}
      {access.can('rebuild', 'list') && (
        <Popconfirm
          title={t.confirmRebuild}
          okText={m.confirm}
          cancelText={m.cancel}
          disabled={!ready || rebuild.command.locked}
          onConfirm={() => void rebuild.start(refresh)}
        >
          <Button type="primary" disabled={!ready || rebuild.command.locked}>
            {t.rebuild}
          </Button>
        </Popconfirm>
      )}
    </Space>
  );
}

/** 结果未知：页面级锁定，只给“重试原请求”；冲突后重读失败：只给“重新读取”。 */
function CommandNotice({ rebuild, refresh }: { rebuild: Rebuild; refresh: () => void }) {
  const { state, status } = rebuild.command;
  if (status === 'unknown')
    return (
      <Alert
        type="warning"
        showIcon
        message={t.uncertain}
        action={<Button onClick={() => void rebuild.replay(refresh)}>{text.retry}</Button>}
      />
    );
  if (status === 'conflict' && state?.readError)
    return (
      <Alert
        type="warning"
        showIcon
        message={t.conflictRead}
        action={<Button onClick={() => void rebuild.reread()}>{t.reread}</Button>}
      />
    );
  return null;
}

function GraphBody({ snapshot, access }: { snapshot: GraphSnapshot | null; access: PageAccess }) {
  if (!snapshot) return <Empty description={access.can('rebuild', 'list') ? t.notGenerated : t.notGeneratedReadOnly} />;
  if (snapshot.empty)
    return (
      <Empty
        description={
          <div className="job-graph-empty">
            <p>{t.emptyTitle}</p>
            {t.emptyRules.map((rule) => (
              <p key={rule}>{rule}</p>
            ))}
          </div>
        }
      />
    );
  return <GraphMatrix snapshot={snapshot} />;
}

function GraphMatrix({ snapshot }: { snapshot: GraphSnapshot }) {
  const grid = graphGrid(snapshot.layout);
  const { headerRows } = snapshot.layout;
  const cells = (row: (typeof grid)[number], header: boolean) =>
    row.map((cell) => {
      const Tag = header || cell.column === 0 ? 'th' : 'td';
      const color = cell.colorKey === undefined ? '' : ` job-graph-type-${cell.colorKey % 3}`;
      const place = cellPlace(cell.row, cell.column, header);
      return (
        <Tag key={cell.column} rowSpan={cell.rowSpan} colSpan={cell.colSpan} className={`${place}${color}`.trim()}>
          {cell.text}
        </Tag>
      );
    });
  return (
    <div className="job-graph-scroll">
      <table className="job-graph-matrix">
        <thead>
          {grid.slice(0, headerRows).map((row, index) => (
            <tr key={index}>{cells(row, true)}</tr>
          ))}
        </thead>
        <tbody>
          {grid.slice(headerRows).map((row, index) => (
            <tr key={index}>{cells(row, false)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 取证底色（设计 §1 样式）：第 1 行、其余表头行、表体职等列各一种。 */
function cellPlace(row: number, column: number, header: boolean) {
  if (row === 0) return 'job-graph-top';
  if (header) return 'job-graph-head';
  return column === 0 ? 'job-graph-grade' : '';
}

function IssuesModal({ onClose }: { onClose: () => void }) {
  const issues = useHref({ search: ISSUES_SEARCH });
  return (
    <Modal
      open
      closable={false}
      onCancel={onClose}
      footer={
        <Space>
          <a href={issues} target="_blank" rel="noopener noreferrer">
            {t.viewIssues}
          </a>
          <Button type="primary" onClick={onClose}>
            {t.gotIt}
          </Button>
        </Space>
      }
    >
      {t.hasIssues}
    </Modal>
  );
}

// 用基本几何图形表达警示，不复用原站图标文件。
function WarningIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M12 3 2 21h20L12 3Z" />
      <path d="M12 10v5M12 18v.5" />
    </svg>
  );
}
