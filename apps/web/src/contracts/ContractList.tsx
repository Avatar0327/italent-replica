import { Alert, Button, Pagination, Space, Table } from 'antd';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import type { PageResult } from '../foundation/client.js';
import { ui } from '../foundation/messages.js';
import { demoCsv } from '../demo-stubs/contracts.js';
import { useRead } from './useRead.js';
import {
  canOpenRecord,
  columnTitle,
  columnKeys,
  employmentColumns,
  listPath,
  listQuery,
  object,
  stubColumns,
  value,
  views,
  width,
  type ListQuery,
  type Row,
  type View,
} from './model.js';
import { m } from './messages.js';
import { DemoNote, employmentOf } from './parts.js';
import { KeywordFilter, ListFilterDrawer } from './Filters.js';
import { ContractButtons } from './ContractForm.js';
import { NameOf, refPaths, useOptions, useToday } from './references.js';
import { RowActions } from './RowActions.js';

function useListState() {
  const [params, setParams] = useSearchParams();
  const view = views.find((v) => v.key === params.get('view'))?.key ?? 'expiring';
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [days, setDays] = useState(30);
  const [filters, setFilters] = useState<ListQuery>({});
  const [drawer, setDrawer] = useState(false);
  const [generation, setGeneration] = useState(0);
  const permission = usePermissions(object);
  const allowed = permission.snapshot.objects[object]?.viewableFields ?? [];
  const result = useRead<PageResult<Row>>(listPath(view, page, days, listQuery(view, filters), pageSize));
  const apply = (next: ListQuery, nextDays = days) => {
    setFilters(next);
    setDays(nextDays);
    setPage(1);
  };
  // 刷新 / 清空已选都回到无筛选的服务端结果，并重读六个视图的总数。
  const reset = () => {
    setFilters({});
    setPage(1);
    setGeneration((n) => n + 1);
    result.refresh();
  };
  const reload = () => {
    setGeneration((n) => n + 1);
    result.refresh();
  };
  // 各视图可用的筛选项不同（入职缺失只认部分参数），切换视图时清空筛选并回到第 1 页。
  const switchView = (next: View) => {
    setParams({ view: next });
    setFilters({});
    setPage(1);
  };
  return {
    view,
    switchView,
    page,
    setPage,
    pageSize,
    setPageSize,
    days,
    filters,
    apply,
    reset,
    reload,
    drawer,
    setDrawer,
    generation,
    allowed,
    result,
  };
}
type State = ReturnType<typeof useListState>;
export function ContractList() {
  const state = useListState();
  return (
    <>
      <ListHeading state={state} />
      <section className="contract-card">
        <ListFilters state={state} />
        <ContractTable state={state} />
      </section>
      {state.drawer && (
        <ListFilterDrawer
          view={state.view}
          days={state.days}
          initial={state.filters}
          onClose={() => state.setDrawer(false)}
          onApply={(next, days) => {
            state.apply(next, days);
            state.setDrawer(false);
          }}
        />
      )}
    </>
  );
}
function ViewCount({ view, days }: { view: View; days: number }) {
  const result = useRead<PageResult<Row>>(listPath(view, 1, days, {}, 1));
  return <strong>{typeof result.data?.total === 'number' ? result.data.total : '--'}</strong>;
}
function ListHeading({ state }: { state: State }) {
  const { view, switchView, days, generation, reload } = state;
  return (
    <>
      <header className="contract-heading">
        <h1>{m.title}</h1>
        <Space>
          <ContractButtons ops={['create']} onDone={reload} />
        </Space>
      </header>
      <nav className="contract-views" aria-label={m.title}>
        {views.map((v) => (
          <button key={v.key} aria-label={v.label} aria-pressed={v.key === view} onClick={() => switchView(v.key)}>
            <span>{v.label}</span>
            <ViewCount key={`${v.key}-${generation}`} view={v.key} days={days} />
          </button>
        ))}
      </nav>
    </>
  );
}
function ListFilters({ state }: { state: State }) {
  const { view, filters, apply, setDrawer, reset } = state;
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
      <div className="contract-toolbar">
        <KeywordFilter
          key={filters.keyword ?? ''}
          value={filters.keyword}
          apply={(keyword) => apply({ ...filters, keyword })}
        />
        <Button type="link" onClick={() => setDrawer(true)}>
          {m.filter}
        </Button>
        <Button type="text" onClick={reset}>
          {m.reset}
        </Button>
      </div>
      <DemoNote />
      <div className="contract-toolbar">
        <Button aria-label={m.refresh} onClick={reset}>
          {m.refresh}
        </Button>
        <Button download="demo-contracts.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(demoCsv())}`}>
          {m.exportDemo}
        </Button>
      </div>
    </>
  );
}
function EmploymentCell({ row, column }: { row: Row; column: string }) {
  const today = useToday();
  const employment = employmentOf(row) ?? {};
  const key = employmentColumns[column]!;
  if (key === 'entryDate') return <>{value(employment.entryDate, 'entryDate')}</>;
  return <NameOf path={refPaths[key as keyof typeof refPaths]} id={employment[key]} asOf={today} />;
}
function useLabels() {
  const types = useOptions(refPaths.typeId);
  const companies = useOptions(refPaths.companyId);
  return (key: string, id: unknown) => {
    const options = key === 'typeId' ? types.options : companies.options;
    return options.find((option) => option.value === id)?.label ?? value(id, key);
  };
}
function RowOperation({ row, view, reload }: { row: Row; view: View; reload(): void }) {
  const navigate = useNavigate();
  if (view === 'missing' && typeof row.employeeId === 'string')
    return (
      <ContractButtons
        ops={['create']}
        employee={{ value: row.employeeId, label: String(row.name ?? row.employeeId) }}
        employment={employmentOf(row)}
        onDone={reload}
      />
    );
  if (row.status === 'in_review' && (view === 'in_review' || row.rowType === 'request'))
    return <RowActions row={row} onChanged={reload} />;
  if (!canOpenRecord(row, view)) return <span>--</span>;
  return (
    <Button
      type="link"
      onClick={() => navigate(`/contracts/records/${encodeURIComponent(String(row.id))}?view=${view}`)}
    >
      {m.open}
    </Button>
  );
}
function ContractTable({ state }: { state: State }) {
  const { view, allowed, result, page, setPage, pageSize, setPageSize, reload } = state;
  const label = useLabels();
  const rows = result.data?.items ?? [];
  const shown = (key: string) =>
    stubColumns.has(key) || (view === 'missing' && key in employmentColumns) || allowed.includes(key);
  const columns = columnKeys(view)
    .filter(shown)
    .map((key) => ({
      key,
      title: columnTitle(key, view),
      width: width(key, view),
      dataIndex: key,
      ellipsis: true,
      render: (input: unknown, row: Row) => {
        if (stubColumns.has(key)) return '--';
        if (view === 'missing' && key in employmentColumns) return <EmploymentCell row={row} column={key} />;
        if (key === 'typeId' || key === 'companyId') return label(key, input);
        return value(input, key);
      },
    }));
  if (result.error) return <PageState kind="error" error={result.error} retry={result.refresh} />;
  const total = result.data?.total;
  return (
    <>
      <Table<Row>
        size="small"
        pagination={false}
        loading={result.loading}
        scroll={{ x: 'max-content' }}
        rowKey={(row) => `${String(row.rowType ?? view)}/${String(row.id ?? row.employeeId)}`}
        dataSource={rows}
        locale={{ emptyText: result.data?.hasDataPermission === false ? m.noScope : m.empty }}
        columns={[
          ...columns,
          {
            key: 'open',
            title: m.operation,
            width: 200,
            fixed: 'right' as const,
            render: (_: unknown, row: Row) => <RowOperation row={row} view={view} reload={reload} />,
          },
        ]}
      />
      <div className="contract-toolbar contract-pagination">
        {typeof total === 'number' && <span>{m.total(total)}</span>}
        <Pagination
          current={page}
          pageSize={pageSize}
          total={total ?? 0}
          disabled={result.loading}
          showSizeChanger={{
            labelRender: ({ value: size }) => `${size}${ui.perPage}`,
            optionRender: ({ value: size }) => `${size}${ui.perPage}`,
          }}
          pageSizeOptions={[15, 20, 50, 100, 200]}
          onChange={(next, size) => {
            setPage(size === pageSize ? next : 1);
            setPageSize(size);
          }}
        />
      </div>
    </>
  );
}
