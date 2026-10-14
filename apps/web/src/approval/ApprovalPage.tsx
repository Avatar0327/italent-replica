import { Alert, Button, Input, Space, Tabs, Tag, type TableColumnsType } from 'antd';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { DecisionNote, ListPage, useApiClient, useSession, type PageRequest } from '../foundation/index.js';
import { approvalList } from './api.js';
import { ApprovalDetail, formatInstant } from './ApprovalDetail.js';
import { messages as m, statusLabels, typeLabels } from './messages.js';
import type { ApprovalList, ApprovalRow, ApprovalView } from './types.js';
import { ReferenceFrame, ReferenceView } from '../transfer/ReferenceView.js';
import './approval.css';

export function ApprovalPage() {
  const [params, setParams] = useSearchParams();
  const value = params.get('view');
  const view: ApprovalView = value === 'completed' || value === 'initiated' ? value : 'pending';
  return (
    <ReferenceFrame>
      <section className="approval-page">
        <Tabs
          tabPosition="left"
          activeKey={view}
          onChange={(key) => setParams({ view: key })}
          items={(['pending', 'completed', 'initiated'] as const).map((key) => ({
            key,
            label: m[key],
            children:
              key === view ? (
                <ApprovalListPanel key={key} view={key} onViewChange={(next) => setParams({ view: next })} />
              ) : null,
          }))}
        />
      </section>
    </ReferenceFrame>
  );
}

export function ApprovalListPanel({
  view = 'initiated',
  onViewChange,
}: {
  view?: ApprovalView;
  onViewChange?(view: string): void;
}) {
  const state = useApprovalList(view);
  const { data, query, selected, page, loading, error, timezone, refresh, setPage, setQuery, setSelected } = state;
  return (
    <div className={onViewChange ? 'approval-list-panel' : 'approval-list-panel approval-applications'}>
      {onViewChange && (
        <ReferenceView
          title={m[view]}
          choices={(['pending', 'completed', 'initiated'] as const).map((key) => ({ key, label: m[key] }))}
          onChange={onViewChange}
          actions={
            <Button onClick={refresh} loading={loading}>
              {m.refresh}
            </Button>
          }
        />
      )}
      <DecisionNote id="approval" />
      {data.demo && <Alert showIcon type="info" message={m.demo} description={m.completedGap} />}
      <div className="r1c-list">
        <ListPage
          title={view === 'initiated' ? m.mine : m[view]}
          data={{ ...data, items: data.items.filter((row) => row.title.includes(query.trim())) }}
          columns={
            !onViewChange ? applicationColumns(setSelected, timezone) : recordColumns(view, setSelected, timezone)
          }
          rowKey={(row) => row.taskId ?? row.id}
          page={page}
          onPageChange={(next) => {
            setPage(next);
            setQuery('');
          }}
          loading={loading}
          error={error}
          retry={refresh}
          filters={
            <Space>
              {!onViewChange && (
                <Button onClick={refresh} loading={loading}>
                  {m.refresh}
                </Button>
              )}
              <Input
                allowClear
                aria-label={m.filter}
                placeholder={m.filter}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <span className="approval-muted">{m.filterHint}</span>
              <span className="approval-muted">
                {page.pageSize}
                {m.perPage}
              </span>
            </Space>
          }
        />
      </div>
      {selected && (
        <ApprovalDetail
          key={selected.id}
          row={selected}
          demo={data.demo}
          onClose={() => setSelected(undefined)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function useApprovalList(view: ApprovalView) {
  const api = useApiClient();
  const { timezone, tenantId, identityKey } = useSession();
  const [page, setPage] = useState<PageRequest>({ page: 1, pageSize: 15 });
  const [query, setQuery] = useState('');
  const [data, setData] = useState<ApprovalList>({ items: [] });
  const [selected, setSelected] = useState<ApprovalRow>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [generation, setGeneration] = useState(0);
  const refresh = () => setGeneration((current) => current + 1);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setData({ items: [] });
    void approvalList(api, view, page, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, view, page, generation, tenantId, identityKey]);
  return { data, query, selected, page, loading, error, timezone, refresh, setPage, setQuery, setSelected };
}

function ApprovalRecord({ row, timezone, onOpen }: { row: ApprovalRow; timezone: string; onOpen(): void }) {
  return (
    <div className="approval-record">
      <span className="approval-record-mark" aria-hidden>
        {m.mark}
      </span>
      <div>
        <Button type="link" className="approval-title-link" onClick={onOpen}>
          {row.title}
        </Button>
        <div className="approval-record-meta">
          <span>{typeLabels[row.approvalType] ?? row.approvalType}</span>
          <Tag color={row.status === 'approved' ? 'green' : 'blue'}>{statusLabels[row.status ?? ''] ?? row.status}</Tag>
          {row.nodeName && <span>{row.nodeName}</span>}
        </div>
        <small className="approval-muted">{formatInstant(row.createdAt, timezone)}</small>
      </div>
    </div>
  );
}

function applicationColumns(onOpen: (row: ApprovalRow) => void, timezone: string): TableColumnsType<ApprovalRow> {
  return [
    {
      title: m.titleColumn,
      key: 'title',
      render: (_: unknown, row: ApprovalRow) => (
        <Button type="link" onClick={() => onOpen(row)}>
          {row.title}
        </Button>
      ),
    },
    { title: m.type, dataIndex: 'approvalType', render: (type: string) => typeLabels[type] ?? type },
    { title: m.status, dataIndex: 'status', render: (status: string) => statusLabels[status] ?? status },
    { title: m.created, dataIndex: 'createdAt', render: (time: string) => formatInstant(time, timezone) },
  ];
}

function recordColumns(
  view: ApprovalView,
  onOpen: (row: ApprovalRow) => void,
  timezone: string,
): TableColumnsType<ApprovalRow> {
  return [
    {
      title: m.titleColumn,
      key: 'content',
      render: (_: unknown, row: ApprovalRow) => (
        <ApprovalRecord row={row} timezone={timezone} onOpen={() => onOpen(row)} />
      ),
    },
    {
      title: m.operation,
      key: 'action',
      width: 110,
      render: (_: unknown, row: ApprovalRow) => (
        <Button onClick={() => onOpen(row)}>{view === 'pending' ? m.handle : m.view}</Button>
      ),
    },
  ];
}
