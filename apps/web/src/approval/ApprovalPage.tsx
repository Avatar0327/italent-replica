import { Alert, Button, Input, Space, Tabs, Tag } from 'antd';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { DecisionNote, ListPage, useApiClient, useSession, type PageRequest } from '../foundation/index.js';
import { approvalList } from './api.js';
import { ApprovalDetail, formatInstant } from './ApprovalDetail.js';
import { messages as m, statusLabels, typeLabels } from './messages.js';
import type { ApprovalList, ApprovalRow, ApprovalView } from './types.js';
import './approval.css';

export function ApprovalPage() {
  const [params, setParams] = useSearchParams();
  const value = params.get('view');
  const view: ApprovalView = value === 'completed' || value === 'initiated' ? value : 'pending';
  return (
    <section className="approval-page">
      <header className="page-heading">
        <h1>{m.title}</h1>
      </header>
      <Tabs
        activeKey={view}
        onChange={(key) => setParams({ view: key })}
        items={(['pending', 'completed', 'initiated'] as const).map((key) => ({
          key,
          label: m[key],
          children: key === view ? <ApprovalListPanel key={key} view={key} /> : null,
        }))}
      />
    </section>
  );
}

export function ApprovalListPanel({ view = 'initiated' }: { view?: ApprovalView }) {
  const state = useApprovalList(view);
  const { data, query, selected, page, loading, error, timezone, refresh, setPage, setQuery, setSelected } = state;
  return (
    <div className="approval-list-panel">
      <DecisionNote id="approval" />
      {data.demo && <Alert showIcon type="info" message={m.demo} description={m.completedGap} />}
      <ListPage
        title={view === 'initiated' ? m.mine : m[view]}
        data={{ ...data, items: data.items.filter((row) => row.title.includes(query.trim())) }}
        columns={[
          {
            title: m.titleColumn,
            key: 'content',
            render: (_: unknown, row: ApprovalRow) => (
              <ApprovalRecord row={row} timezone={timezone} onOpen={() => setSelected(row)} />
            ),
          },
          {
            title: m.operation,
            key: 'action',
            width: 110,
            render: (_: unknown, row: ApprovalRow) => (
              <Button onClick={() => setSelected(row)}>{view === 'pending' ? m.handle : m.view}</Button>
            ),
          },
        ]}
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
            <Input
              allowClear
              aria-label={m.filter}
              placeholder={m.filter}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <span className="approval-muted">{m.filterHint}</span>
          </Space>
        }
        actions={
          <Button onClick={refresh} loading={loading}>
            {m.refresh}
          </Button>
        }
      />
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
  const [page, setPage] = useState<PageRequest>({ page: 1, pageSize: 20 });
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
