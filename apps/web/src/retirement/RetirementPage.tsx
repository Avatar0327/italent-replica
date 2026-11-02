import { RETIREMENT_UPCOMING_DAYS } from '@italent/domain';
import { Button, InputNumber, Space, Table } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { NameOf } from '../contracts/references.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { InternCommands } from '../intern/commands.js';
import { refPaths } from '../part-time/references.js';
import { useRead } from '../part-time/useRead.js';
import { m } from './messages.js';
import {
  cellValue,
  columns,
  isPersonView,
  listPath,
  pageSize,
  views,
  type Filters,
  type ListResult,
  type RetirementView,
  type Row,
} from './model.js';
import { PersonDetail, RetirementDetail } from './RetirementDetail.js';
import './retirement.css';

const personObject = 'TenantBase.Employee';

export function RetirementPage() {
  return (
    <div className="retirement-page">
      <DecisionNote id="retirements" />
      {/* 草稿上下文与未确认命令放页面层（claude_fe_rules e）：关掉详情、换视图后锁仍在 */}
      <InternCommands>
        <RetirementList />
      </InternCommands>
    </div>
  );
}

function RetirementList() {
  const [params, setParams] = useSearchParams();
  const view = views.find((item) => item.key === params.get('view'))?.key ?? 'upcoming';
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({});
  // 入口按行所属视图判定：选中时连同视图一起记下，切换视图的瞬间点到旧行也不会张冠李戴
  const [selected, select] = useState<{ view: RetirementView; row: Row }>();
  const result = useRead<ListResult>(listPath(view, page, filters));
  const switchView = (next: RetirementView) => {
    setParams({ view: next });
    setPage(1);
    setFilters({});
    select(undefined);
  };
  const applyFilters = (next: Filters) => {
    setPage(1);
    setFilters(next);
  };
  const items = result.data?.items ?? [];
  const close = () => select(undefined);
  return (
    <>
      <h1>{m.title}</h1>
      <nav className="retirement-views" aria-label={m.title}>
        {views.map((item) => (
          <button key={item.key} aria-pressed={view === item.key} onClick={() => switchView(item.key)}>
            {item.label}
          </button>
        ))}
      </nav>
      <section className="retirement-card">
        <FilterBar key={view} view={view} onApply={applyFilters} onRefresh={result.refresh} />
        {result.error ? (
          <PageState kind="error" error={result.error} retry={result.refresh} />
        ) : (
          <RetirementTable
            view={view}
            rows={items}
            loading={result.loading}
            noScope={result.data?.hasDataPermission === false}
            onOpen={(row) => select({ view, row })}
          />
        )}
        <div className="retirement-pagination">
          <Button disabled={page === 1 || result.loading} onClick={() => setPage(page - 1)}>
            {m.previous}
          </Button>
          <span>{m.page(page)}</span>
          <Button disabled={items.length < pageSize || result.loading} onClick={() => setPage(page + 1)}>
            {m.next}
          </Button>
        </div>
      </section>
      {selected &&
        (isPersonView(selected.view) ? (
          <PersonDetail
            key={`${selected.view}/${selected.row.employeeId}`}
            view={selected.view}
            row={selected.row}
            onClose={close}
            refresh={result.reload}
          />
        ) : (
          <RetirementDetail
            key={`${selected.view}/${selected.row.id}`}
            view={selected.view}
            row={selected.row}
            onClose={close}
            refresh={result.reload}
          />
        ))}
    </>
  );
}

/**
 * 后端只收统计日期与“即将退休”天数（retirement-view-routes.ts）；天数按人事预计退休日期筛人，
 * 该字段不可见就不显示控件、也不进请求（claude_fe_rules d）。关键字 / 部门筛选后端无参数，不做假控件。
 */
type FilterProps = { view: RetirementView; onApply(filters: Filters): void; onRefresh(): void };
function FilterBar({ view, onApply, onRefresh }: FilterProps) {
  const person = usePermissions(personObject);
  const daysAllowed = view === 'upcoming' && person.field('expectedRetirementDate').visible;
  const [draft, setDraft] = useState<Filters>({});
  const reset = () => {
    setDraft({});
    onApply({});
  };
  const apply = () => onApply({ asOf: draft.asOf, ...(daysAllowed ? { upcomingDays: draft.upcomingDays } : {}) });
  return (
    <Space className="retirement-toolbar" wrap>
      <span aria-label={m.asOf}>
        {m.asOf}{' '}
        <TenantDatePicker
          value={draft.asOf ?? null}
          onChange={(asOf) => setDraft({ ...draft, asOf: asOf ?? undefined })}
        />
      </span>
      {daysAllowed && (
        <InputNumber
          aria-label={m.upcomingDays}
          placeholder={m.upcomingDays}
          min={RETIREMENT_UPCOMING_DAYS.min}
          max={RETIREMENT_UPCOMING_DAYS.max}
          precision={0}
          value={draft.upcomingDays ?? null}
          onChange={(upcomingDays) => setDraft({ ...draft, upcomingDays })}
        />
      )}
      <Button type="primary" onClick={apply}>
        {m.search}
      </Button>
      <Button onClick={reset}>{m.reset}</Button>
      <Button onClick={onRefresh}>{m.refresh}</Button>
    </Space>
  );
}

const references: Record<string, string | undefined> = {
  departmentId: refPaths.departmentId,
  positionId: refPaths.positionId,
};
type TableProps = { view: RetirementView; rows: Row[]; loading: boolean; noScope: boolean; onOpen(row: Row): void };
function RetirementTable({ view, rows, loading, noScope, onOpen }: TableProps) {
  return (
    <Table<Row>
      className="retirement-table"
      size="small"
      rowKey={(row) => String(isPersonView(view) ? row.employeeId : row.id)}
      pagination={false}
      loading={loading}
      dataSource={rows}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: noScope ? m.noScope : m.empty }}
      columns={[
        ...columns[view].map((key) => ({
          key,
          title: m.fields[key],
          render: (_: unknown, row: Row) =>
            references[key] ? <NameOf path={references[key]} id={row[key]} /> : cellValue(row, key),
        })),
        {
          key: 'operation',
          title: m.operation,
          fixed: 'right' as const,
          render: (_: unknown, row: Row) => (
            <Button type="link" disabled={!row.employeeId} onClick={() => onOpen(row)}>
              {m.open}
            </Button>
          ),
        },
      ]}
    />
  );
}
