import { Button, Input, Space, Table } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { NameOf, RefSelect } from '../contracts/references.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { refPaths } from '../part-time/references.js';
import { useRead } from '../part-time/useRead.js';
import { InternCommands } from './commands.js';
import { InternDetail } from './InternDetail.js';
import { m } from './messages.js';
import {
  allowedFilters,
  cellValue,
  columns,
  listPath,
  object,
  pageSize,
  personObject,
  views,
  type Filters,
  type InternView,
  type ListResult,
  type Row,
} from './model.js';
import './intern.css';

export function InternPage() {
  return (
    <div className="intern-page">
      <DecisionNote id="interns" />
      <InternCommands>
        <InternList />
      </InternCommands>
    </div>
  );
}

/** 关键字要姓名、工号都可见，部门要任职记录部门可见；不可见就不显示控件、也不进请求（claude_fe_rules d）。 */
function useFilterPermission() {
  const employment = usePermissions(object);
  const person = usePermissions(personObject);
  return (key: keyof Filters) =>
    key === 'keyword'
      ? person.field('name').visible && person.field('code').visible
      : employment.field('departmentId').visible;
}

function InternList() {
  const [params, setParams] = useSearchParams();
  const view = views.find((item) => item.key === params.get('view'))?.key ?? 'interning';
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({});
  // 入口按行所属视图判定：选中时连同视图一起记下，切换视图的瞬间点到旧行也不会张冠李戴
  const [selected, select] = useState<{ view: InternView; row: Row }>();
  const allowed = useFilterPermission();
  const result = useRead<ListResult>(listPath(view, page, allowedFilters(filters, allowed)));
  const switchView = (next: InternView) => {
    setParams({ view: next });
    setPage(1);
    setFilters({});
    select(undefined);
  };
  const items = result.data?.items ?? [];
  return (
    <>
      <h1>{m.title}</h1>
      <nav className="intern-views" aria-label={m.title}>
        {views.map((item) => (
          <button key={item.key} aria-pressed={view === item.key} onClick={() => switchView(item.key)}>
            {item.label}
          </button>
        ))}
      </nav>
      <section className="intern-card">
        <FilterBar
          key={view}
          allowed={allowed}
          onApply={(next) => {
            setFilters(next);
            setPage(1);
          }}
          onRefresh={result.refresh}
        />
        {result.error ? (
          <PageState kind="error" error={result.error} retry={result.refresh} />
        ) : (
          <InternTable
            view={view}
            rows={items}
            loading={result.loading}
            noScope={result.data?.hasDataPermission === false}
            onOpen={(row) => select({ view, row })}
          />
        )}
        <div className="intern-pagination">
          <Button disabled={page === 1 || result.loading} onClick={() => setPage(page - 1)}>
            {m.previous}
          </Button>
          <span>{m.page(page)}</span>
          <Button disabled={items.length < pageSize || result.loading} onClick={() => setPage(page + 1)}>
            {m.next}
          </Button>
        </div>
      </section>
      {selected && (
        <InternDetail
          key={`${selected.view}/${selected.row.id}`}
          view={selected.view}
          row={selected.row}
          onClose={() => select(undefined)}
          refresh={() => result.reload()}
        />
      )}
    </>
  );
}

function FilterBar({
  allowed,
  onApply,
  onRefresh,
}: {
  allowed: (key: keyof Filters) => boolean;
  onApply(filters: Filters): void;
  onRefresh(): void;
}) {
  const [draft, setDraft] = useState<Filters>({});
  const apply = (next: Filters) => onApply(allowedFilters({ ...next, keyword: next.keyword?.trim() }, allowed));
  return (
    <Space className="intern-toolbar" wrap>
      {allowed('keyword') && (
        <Input
          allowClear
          aria-label={m.keyword}
          placeholder={m.keyword}
          value={draft.keyword}
          onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
          onPressEnter={() => apply(draft)}
        />
      )}
      {allowed('departmentId') && (
        <RefSelect
          path={refPaths.departmentId!}
          ariaLabel={m.department}
          value={draft.departmentId ?? null}
          onChange={(value) => setDraft({ ...draft, departmentId: typeof value === 'string' ? value : undefined })}
        />
      )}
      <Button type="primary" onClick={() => apply(draft)}>
        {m.search}
      </Button>
      <Button
        onClick={() => {
          setDraft({});
          onApply({});
        }}
      >
        {m.reset}
      </Button>
      <Button onClick={onRefresh}>{m.refresh}</Button>
    </Space>
  );
}

const references: Record<string, string | undefined> = {
  departmentId: refPaths.departmentId,
  positionId: refPaths.positionId,
};
function InternTable({
  view,
  rows,
  loading,
  noScope,
  onOpen,
}: {
  view: InternView;
  rows: Row[];
  loading: boolean;
  noScope: boolean;
  onOpen(row: Row): void;
}) {
  return (
    <Table<Row>
      className="intern-table"
      size="small"
      rowKey="id"
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
            references[key] ? <NameOf path={references[key]} id={row[key as keyof Row]} /> : cellValue(row, key),
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
