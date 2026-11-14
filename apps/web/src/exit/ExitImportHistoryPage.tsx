import { Button, DatePicker, Select, Space, Table } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../foundation/client.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { useRead } from '../part-time/useRead.js';
import { importEntryVisible } from './ExitImport.js';
import { ImportFileDownload } from './ImportFileDownload.js';
import {
  HISTORY_STATUSES,
  historyPath,
  parseHistory,
  tenantMinute,
  type HistoryFilters,
  type HistoryItem,
  type HistoryStatus,
} from './import-history-model.js';
import { x, xh } from './messages.js';
import { object } from './exit-model.js';
import './exit.css';

/** F-493 §9.5：本人导入批次；无导入按钮显示无权限、不发请求（后端以 §8.4 为准）。 */
export function ExitImportHistoryPage() {
  const access = useImportAccess();
  return (
    <div className="exit-page exit-import-history">
      <DecisionNote id="exit-import-history" />
      <div className="exit-heading">
        <h1>{xh.title}</h1>
      </div>
      {access.state === 'loading' && <PageState kind="loading" />}
      {access.state === 'error' && <PageState kind="error" error={access.error} retry={access.refresh} />}
      {access.state === 'denied' && <PageState kind="forbidden" refresh={access.refresh} />}
      {access.state === 'allowed' && <HistoryList refresh={access.refresh} />}
    </div>
  );
}

/** 入口摘要（summary）不含按钮，须等对象明细；明细读回为空（无对象权）即判无权限。 */
function useImportAccess() {
  const permissions = usePermissions(object);
  const permission = permissions.snapshot.objects[object];
  const { loading, error, ensure, refresh } = permissions;
  const [missing, setMissing] = useState(false);
  const pending = !permission || permission.summary === true;
  useEffect(() => {
    setMissing(false);
    if (loading || error || !pending) return;
    const controller = new AbortController();
    void ensure(object, controller.signal).then((loaded) => {
      if (!controller.signal.aborted && !loaded) setMissing(true);
    });
    return () => controller.abort();
  }, [loading, error, pending, ensure]);
  if (error) return { state: 'error', error, refresh } as const;
  if (missing) return { state: 'denied', refresh } as const;
  if (loading || pending) return { state: 'loading', refresh } as const;
  return { state: importEntryVisible(permission) ? 'allowed' : 'denied', refresh } as const;
}

function HistoryList(props: { refresh(): void }) {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<HistoryFilters>({ status: [] });
  const result = useRead<unknown>(historyPath(page, filters));
  const data = useMemo(() => (result.data === undefined ? undefined : parseHistory(result.data)), [result.data]);
  const apply = (next: HistoryFilters) => {
    setPage(1);
    setFilters(next);
  };
  if (result.error instanceof ApiError && result.error.kind === 'forbidden')
    return <PageState kind="forbidden" refresh={props.refresh} />;
  return (
    <section className="exit-card">
      <Space wrap className="exit-import-history-filters">
        <Select<HistoryStatus[]>
          mode="multiple"
          allowClear
          aria-label={xh.statusFilter}
          placeholder={xh.statusFilter}
          style={{ minWidth: 200 }}
          value={filters.status}
          options={HISTORY_STATUSES.map((value) => ({ value, label: xh.status[value] }))}
          onChange={(status) => apply({ ...filters, status })}
        />
        <DatePicker.RangePicker
          aria-label={xh.timeFilter}
          placeholder={[xh.from, xh.to]}
          value={[filters.from ? dayjs(filters.from) : null, filters.to ? dayjs(filters.to) : null]}
          onChange={(dates) =>
            apply({ ...filters, from: dates?.[0]?.format('YYYY-MM-DD'), to: dates?.[1]?.format('YYYY-MM-DD') })
          }
        />
        <Button onClick={result.refresh}>{x.refresh}</Button>
      </Space>
      {result.error ? (
        <PageState kind="error" error={result.error} retry={result.refresh} />
      ) : result.data !== undefined && !data ? (
        <PageState
          kind="error"
          error={new ApiError(502, 'INVALID_RESPONSE', 'unknown', xh.invalid)}
          retry={result.refresh}
        />
      ) : (
        <HistoryTable rows={data?.items ?? []} loading={result.loading} />
      )}
      <Space className="exit-pagination">
        <Button disabled={page === 1 || result.loading} onClick={() => setPage(page - 1)}>
          {x.previous}
        </Button>
        <span>{xh.page(page)}</span>
        <Button disabled={!data?.hasNext || result.loading} onClick={() => setPage(page + 1)}>
          {x.next}
        </Button>
      </Space>
    </section>
  );
}

function HistoryTable(props: { rows: HistoryItem[]; loading: boolean }) {
  const { timezone } = useSession();
  const c = xh.columns;
  return (
    <Table<HistoryItem>
      rowKey="id"
      size="small"
      pagination={false}
      loading={props.loading}
      dataSource={props.rows}
      columns={[
        { key: 'importType', title: c.importType, render: () => xh.type },
        { key: 'createdAt', title: c.createdAt, render: (_, row) => tenantMinute(row.createdAt, timezone) },
        { key: 'submitterName', title: c.submitterName, render: (_, row) => row.submitterName || x.missing },
        { key: 'status', title: c.status, render: (_, row) => xh.status[row.status] },
        {
          key: 'result',
          title: c.result,
          render: (_, row) => (row.errorCount === null ? xh.none : xh.result(row.total, row.errorCount)),
        },
        { key: 'errorFile', title: c.errorFile, render: (_, row) => <ErrorFileCell row={row} /> },
        { key: 'sourceFile', title: c.sourceFile, render: (_, row) => <SourceFileCell row={row} /> },
      ]}
    />
  );
}

function ErrorFileCell({ row }: { row: HistoryItem }) {
  if (!row.hasErrorFile) return xh.none;
  if (row.filesExpired) return <span>{xh.expired}</span>;
  return <ImportFileDownload businessId={row.id}>{xh.errorFile}</ImportFileDownload>;
}
function SourceFileCell({ row }: { row: HistoryItem }) {
  if (row.filesExpired) return <span>{xh.expired}</span>;
  return (
    <ImportFileDownload businessId={row.id} file="source-file" fallbackName={row.fileName}>
      {row.fileName}
    </ImportFileDownload>
  );
}
