import { Button, Input, Space, Table } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { NameOf, RefSelect } from '../contracts/references.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { InternCommands } from '../intern/commands.js';
import { refPaths } from '../part-time/references.js';
import { useRead } from '../part-time/useRead.js';
import { m } from './messages.js';
import {
  allowedFilters,
  cellValue,
  columns,
  entriesFor,
  listPath,
  object,
  pageSize,
  personObject,
  views,
  type Filters,
  type ListResult,
  type ProbationView,
  type Row,
} from './model.js';
import { ProbationDetail } from './ProbationDetail.js';
import { BatchForm } from './ProbationForm.js';
// 视图卡片、工具栏、分页与实习管理同一套页面样式
import '../intern/intern.css';

export function ProbationPage() {
  return (
    <div className="intern-page">
      <DecisionNote id="probations" />
      <InternCommands>
        <ProbationList />
      </InternCommands>
    </div>
  );
}

/** 人员（关键字）要姓名、工号都可见，部门 / 职务要任职字段可见；不可见不显示控件、也不进请求（claude_fe_rules d）。 */
function useFilterPermission() {
  const employment = usePermissions(object);
  const person = usePermissions(personObject);
  return (key: keyof Filters) => {
    if (key === 'keyword') return person.field('name').visible && person.field('code').visible;
    if (key === 'departmentId' || key === 'postId') return employment.field(key).visible;
    return true;
  };
}

function useProbationList() {
  const [params, setParams] = useSearchParams();
  const view = views.find((item) => item.key === params.get('view'))?.key ?? 'expiring';
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({});
  // 选中时连同视图一起记下：切换视图的瞬间点到旧行也不会按新视图推导入口
  const [selected, select] = useState<{ view: ProbationView; row: Row }>();
  const [checked, check] = useState<Row[]>([]);
  const [batch, setBatch] = useState(false);
  const allowed = useFilterPermission();
  const result = useRead<ListResult>(listPath(view, page, allowedFilters(filters, allowed)));
  const reset = (next: ProbationView) => {
    setParams({ view: next });
    setPage(1);
    setFilters({});
    select(undefined);
    check([]);
  };
  const changePage = (next: number) => {
    check([]);
    setPage(next);
  };
  return {
    view,
    page,
    changePage,
    applyFilters: (next: Filters) => {
      changePage(1);
      setFilters(next);
    },
    selected,
    open: (row: Row) => select({ view, row }),
    close: () => select(undefined),
    checked,
    check,
    batch,
    setBatch,
    allowed,
    result,
    switchView: reset,
    // 写后切到目的视图（直接转正 → 已转正，申请提交 → 转正审批中），否则刷新当前视图
    refresh: async (destination?: ProbationView) => {
      check([]);
      if (destination && destination !== view) reset(destination);
      else result.refresh();
    },
  };
}

function ProbationList() {
  const list = useProbationList();
  const { view, page, result, checked } = list;
  const permission = usePermissions(object).snapshot.objects[object];
  const items = result.data?.items ?? [];
  // 批量转正只在可发起转正的视图，且逐行入口允许转正的行才可勾选（PB-R8 / PB-R9）
  const batchable = (row: Row) => entriesFor(view, row, permission).includes('regularize');
  const selectable = (view === 'expiring' || view === 'all') && items.some(batchable);
  return (
    <>
      <h1>{m.title}</h1>
      <nav className="intern-views" aria-label={m.title}>
        {views.map((item) => (
          <button key={item.key} aria-pressed={view === item.key} onClick={() => list.switchView(item.key)}>
            {item.label}
          </button>
        ))}
      </nav>
      <section className="intern-card">
        <FilterBar key={view} allowed={list.allowed} onApply={list.applyFilters} onRefresh={result.refresh} />
        {selectable && (
          <Space className="intern-toolbar">
            <Button disabled={!checked.length} onClick={() => list.setBatch(true)}>
              {m.entries.batch}
            </Button>
            <span>{m.selected(checked.length)}</span>
          </Space>
        )}
        {result.error ? (
          <PageState kind="error" error={result.error} retry={result.refresh} />
        ) : (
          <ProbationTable
            view={view}
            rows={items}
            loading={result.loading}
            noScope={result.data?.hasDataPermission === false}
            checked={selectable ? checked : undefined}
            batchable={batchable}
            onCheck={list.check}
            onOpen={list.open}
          />
        )}
        <div className="intern-pagination">
          <Button disabled={page === 1 || result.loading} onClick={() => list.changePage(page - 1)}>
            {m.previous}
          </Button>
          <span>{m.page(page)}</span>
          <Button disabled={items.length < pageSize || result.loading} onClick={() => list.changePage(page + 1)}>
            {m.next}
          </Button>
        </div>
      </section>
      {list.selected && (
        <ProbationDetail
          key={`${list.selected.view}/${list.selected.row.id}`}
          view={list.selected.view}
          row={list.selected.row}
          onClose={list.close}
          refresh={list.refresh}
        />
      )}
      {list.batch && (
        <BatchForm
          rows={checked}
          onClose={() => list.setBatch(false)}
          onDone={() => {
            list.setBatch(false);
            void list.refresh();
          }}
          refresh={list.refresh}
        />
      )}
    </>
  );
}

type TableProps = { view: ProbationView; rows: Row[]; loading: boolean; noScope: boolean; onOpen(row: Row): void };
/** checked：不可批量的视图不传，表格不出选择列；批量上限 100 人（/regularizations）。 */
function ProbationTable(
  props: TableProps & { checked?: Row[]; batchable(row: Row): boolean; onCheck(rows: Row[]): void },
) {
  const { view, rows, loading, noScope, checked, batchable, onCheck, onOpen } = props;
  return (
    <Table<Row>
      className="probation-table"
      size="small"
      rowKey="id"
      pagination={false}
      loading={loading}
      dataSource={rows}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: noScope ? m.noScope : m.empty }}
      rowSelection={
        checked
          ? {
              selectedRowKeys: checked.map((row) => row.id),
              getCheckboxProps: (row) => ({ disabled: !batchable(row) }),
              onChange: (_, rows) => onCheck(rows.slice(0, 100)),
            }
          : undefined
      }
      columns={[
        ...columns[view].map((key) => ({
          key,
          title: m.fields[key],
          render: (_: unknown, row: Row) => <Cell row={row} field={key} />,
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

// 部门、机构都是组织引用，职务是职务引用；被裁剪的字段缺键，显示占位
const references: Record<string, string | undefined> = {
  departmentId: refPaths.departmentId,
  organizationId: refPaths.departmentId,
  postId: refPaths.postId,
};
function Cell({ row, field }: { row: Row; field: string }) {
  const id = row[field as keyof Row];
  const path = references[field];
  return path && typeof id === 'string' ? <NameOf path={path} id={id} /> : <>{cellValue(row, field)}</>;
}

type FilterProps = { allowed: (key: keyof Filters) => boolean; onApply(filters: Filters): void; onRefresh(): void };
function FilterBar({ allowed, onApply, onRefresh }: FilterProps) {
  const [draft, setDraft] = useState<Filters>({});
  const apply = (next: Filters) => onApply(allowedFilters({ ...next, keyword: next.keyword?.trim() }, allowed));
  const set = (key: keyof Filters) => (value: unknown) =>
    setDraft({ ...draft, [key]: typeof value === 'string' && value ? value : undefined });
  const reset = () => {
    setDraft({});
    onApply({});
  };
  const date = (key: 'expectedEndFrom' | 'expectedEndTo', label: string) => (
    <Input type="date" aria-label={label} value={draft[key] ?? ''} onChange={(event) => set(key)(event.target.value)} />
  );
  return (
    <Space className="intern-toolbar" wrap>
      {allowed('keyword') && (
        <Input
          allowClear
          aria-label={m.keyword}
          placeholder={m.keyword}
          value={draft.keyword}
          onChange={(event) => set('keyword')(event.target.value)}
          onPressEnter={() => apply(draft)}
        />
      )}
      {allowed('departmentId') && (
        <RefSelect
          path={refPaths.departmentId!}
          ariaLabel={m.department}
          value={draft.departmentId ?? null}
          onChange={set('departmentId')}
        />
      )}
      {allowed('postId') && (
        <RefSelect path={refPaths.postId!} ariaLabel={m.post} value={draft.postId ?? null} onChange={set('postId')} />
      )}
      {date('expectedEndFrom', m.expectedFrom)}
      {date('expectedEndTo', m.expectedTo)}
      <Button type="primary" onClick={() => apply(draft)}>
        {m.search}
      </Button>
      <Button onClick={reset}>{m.reset}</Button>
      <Button onClick={onRefresh}>{m.refresh}</Button>
    </Space>
  );
}
