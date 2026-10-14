import { Alert, Button, InputNumber, Space, Table } from 'antd';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import type { PageResult } from '../foundation/client.js';
import { previewContracts, contractTypes, demoCsv } from '../demo-stubs/contracts.js';
import { useRead } from './useRead.js';
import {
  canOpenRecord,
  columnTitle,
  visibleColumnKeys,
  listPath,
  object,
  value,
  views,
  width,
  type Filters,
  type Row,
} from './model.js';
import { m } from './messages.js';
import { Coming, DemoNote } from './parts.js';
import { FilterDrawer, QuickFilters } from './Filters.js';
function useListState() {
  const [params, setParams] = useSearchParams();
  const view = views.find((v) => v.key === params.get('view'))?.key ?? 'expiring';
  const [page, setPage] = useState(1);
  const [days, setDays] = useState(30);
  const [filters, setFilters] = useState<Filters>({});
  const [demo, setDemo] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const permission = usePermissions(object);
  const allowed = permission.snapshot.objects[object]?.viewableFields ?? [];
  const navigate = useNavigate();
  const result = useRead<PageResult<Row>>(listPath(view, page, days));
  const rows = demo ? previewContracts(filters, view) : (result.data?.items ?? []);
  const apply = (next: Filters) => {
    setFilters(next);
    setDemo(true);
    setPage(1);
  };
  const returnToLive = () => {
    setFilters({});
    setDemo(false);
    setPage(1);
    result.refresh();
  };
  return {
    view,
    page,
    setPage,
    days,
    setDays,
    filters,
    demo,
    returnToLive,
    drawer,
    setDrawer,
    allowed,
    navigate,
    result,
    rows,
    apply,
    setParams,
  };
}
type State = ReturnType<typeof useListState>;
export function ContractList() {
  const state = useListState();
  const { drawer, setDrawer, filters, apply } = state;
  return (
    <>
      <ListHeading state={state} />
      <section className="contract-card">
        <ListFilters state={state} />
        <ContractTable state={state} />
      </section>
      {drawer && (
        <FilterDrawer
          days={state.days}
          setDays={state.setDays}
          initial={filters}
          close={() => setDrawer(false)}
          apply={(next) => {
            apply(next);
            setDrawer(false);
          }}
        />
      )}
    </>
  );
}
function ListHeading({ state }: { state: State }) {
  const { view, setParams, returnToLive } = state;
  return (
    <>
      <header className="contract-heading">
        <h1>{m.title}</h1>
        <Coming />
      </header>
      <nav className="contract-views" aria-label={m.title}>
        {views.map((v) => (
          <button
            key={v.key}
            aria-label={v.label}
            aria-pressed={v.key === view}
            onClick={() => {
              setParams({ view: v.key });
              returnToLive();
            }}
          >
            <span>{v.label}</span>
            <strong>--</strong>
          </button>
        ))}
      </nav>
    </>
  );
}
function ListFilters({ state }: { state: State }) {
  const { view, days, setDays, setPage, filters, apply, setDrawer, returnToLive, demo } = state;
  return (
    <>
      <Alert
        type="info"
        showIcon
        message={
          {
            missing: m.missingHint,
            expiring: m.expiringHint,
            expired_unrenewed: m.expiredHint,
            valid: m.validHint,
            all: m.allHint,
            in_review: m.allHint,
          }[view]
        }
      />
      {view === 'expiring' && <p className="contract-muted">{m.backendHint}</p>}
      <div className="contract-toolbar">
        {view === 'expiring' && (
          <label>
            {m.fields.days}
            <InputNumber
              aria-label={m.fields.days}
              min={1}
              max={3660}
              precision={0}
              value={days}
              onChange={(n) => {
                if (n) {
                  setDays(n);
                  setPage(1);
                }
              }}
            />
          </label>
        )}
        <QuickFilters view={view} value={filters} change={apply} />
        <Button type="link" onClick={() => setDrawer(true)}>
          {m.filter}
        </Button>
        <Button type="text" onClick={returnToLive}>
          {m.reset}
        </Button>
      </div>
      {demo && <DemoNote />}
      <div className="contract-toolbar">
        <Button aria-label={m.refresh} onClick={returnToLive}>
          {m.refresh}
        </Button>
        <Button onClick={() => (demo ? returnToLive() : apply(filters))}>{demo ? m.live : m.preview}</Button>
        <Button
          disabled={!demo}
          download="demo-contracts.csv"
          href={demo ? `data:text/csv;charset=utf-8,${encodeURIComponent(demoCsv(filters, view))}` : undefined}
        >
          {m.exportDemo}
        </Button>
      </div>
    </>
  );
}
function ContractTable({ state }: { state: State }) {
  const { view, rows, demo, allowed, navigate, result, page, setPage } = state;
  const columns = visibleColumnKeys(view, allowed, demo).map((key) => ({
      key,
      title: columnTitle(key, view),
      width: width(key, view),
      dataIndex: key,
      ellipsis: true,
      sorter: demo ? (a: Row, b: Row) => value(a[key], key).localeCompare(value(b[key], key), 'zh-CN') : undefined,
      render: (input: unknown) =>
        demo && key === 'typeId' ? (contractTypes.find((t) => t.id === input)?.name ?? '--') : value(input, key),
    }));
  return !demo && result.error ? (
    <PageState kind="error" error={result.error} retry={result.refresh} />
  ) : (
    <>
      <Table<Row>
        size="small"
        pagination={false}
        loading={!demo && result.loading}
        scroll={{ x: 'max-content' }}
        rowKey={(row) => `${row.rowType ?? view}/${row.id ?? row.employeeId}`}
        dataSource={rows}
        locale={{ emptyText: !demo && result.data?.hasDataPermission === false ? m.noScope : m.empty }}
        columns={[
          ...columns,
          {
            key: 'open',
            title: m.detail,
            width: 164,
            render: (_: unknown, row: Row) =>
              !demo && canOpenRecord(row, view) ? (
                <Button
                  type="link"
                  onClick={() => navigate(`/contracts/records/${encodeURIComponent(String(row.id))}?view=${view}`)}
                >
                  {m.open}
                </Button>
              ) : (
                <span>--</span>
              ),
          },
        ]}
      />
      <div className="contract-toolbar">
        <span className="contract-muted">
          {m.countHint} · {m.pageHint}
        </span>
        <Space>
          <Button disabled={demo || page === 1 || result.loading} onClick={() => setPage((n) => n - 1)}>
            {m.previous}
          </Button>
          <span>{page}</span>
          <Button disabled={demo || rows.length < 15 || result.loading} onClick={() => setPage((n) => n + 1)}>
            {m.next}
          </Button>
        </Space>
      </div>
    </>
  );
}
