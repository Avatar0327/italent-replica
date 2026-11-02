import { Button, Input, Space, Table, type TableProps } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { NameOf, RefSelect } from '../contracts/references.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { refPaths } from '../part-time/references.js';
import { useRead } from '../part-time/useRead.js';
import { InternCommands } from './commands.js';
import { CreateIntern } from './CreateIntern.js';
import { canCreatePerson, type CreateReceipt } from './create-model.js';
import { c } from './create-messages.js';
import { ApplicationLocation, useApplicationLocation } from './ApplicationLocation.js';
import { InternDetail } from './InternDetail.js';
import { useNavigationGuard, type NavigationGuard } from './navigation.js';
import { m } from './messages.js';
import {
  allowedFilters,
  cellValue,
  columns,
  listPath,
  nextSort,
  object,
  pageSize,
  personObject,
  sortable,
  views,
  type Filters,
  type Sort,
  type SortKey,
  type ApplicationDestination,
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

/**
 * F-366 表头单列排序：排序列须任职记录字段可见，否则不给表头排序、也不进请求（服务端同样 403）。
 * 点击循环交给 nextSort（升 → 降 → 取消，换列替换）；排序一变回到第 1 页。
 * 排序跟着页签走：view 一变（点页签、申请定位，或浏览器后退 / 前进改了 URL）就清空，回来不套用旧排序。
 */
function useInternSort(view: InternView, firstPage: () => void) {
  const employment = usePermissions(object);
  const [chosen, setChosen] = useState<{ view: InternView; sort?: Sort }>({ view });
  if (chosen.view !== view) setChosen({ view });
  const canSort = (key: string): key is SortKey => sortable(view, key) && employment.field(key).visible;
  const sort = chosen.view === view && chosen.sort && canSort(chosen.sort.sortBy) ? chosen.sort : undefined;
  const apply = (next: Sort | undefined) => {
    firstPage();
    setChosen({ view, sort: next });
  };
  return {
    sort,
    canSort,
    change: (key: SortKey) => apply(nextSort(sort, key)),
    cancel: () => apply(undefined),
    reset: () => setChosen({ view }),
  };
}
type InternSorting = ReturnType<typeof useInternSort>;

function useInternList() {
  const [params, setParams] = useSearchParams();
  const person = usePermissions(personObject);
  const createAllowed = canCreatePerson(person.snapshot.objects[personObject]);
  const view = views.find((item) => item.key === params.get('view'))?.key ?? 'interning';
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({});
  const [location, locate] = useApplicationLocation(view);
  // 入口按行所属视图判定：选中时连同视图一起记下，切换视图的瞬间点到旧行也不会张冠李戴
  const [selected, select] = useState<{ view: InternView; row: Row }>();
  const allowed = useFilterPermission();
  const sorting = useInternSort(view, () => changePage(1));
  const result = useRead<ListResult>(listPath(view, page, allowedFilters(filters, allowed), sorting.sort));
  const refreshList = useRef(result.refresh);
  refreshList.current = result.refresh;
  const switchView = (next: InternView) => {
    setParams({ view: next });
    setPage(1);
    setFilters({});
    sorting.reset();
    select(undefined);
    locate(undefined);
  };
  const guard = useNavigationGuard();
  const create = useInternCreation(guard, () => {
    switchView('interning');
    result.refresh();
  });
  const items = result.data?.items ?? [];
  const located = useCallback((page: number) => {
    refreshList.current();
    setPage(page);
    locate(undefined);
  }, []);
  const refresh = () => result.reload();
  // 申请确认后切到目标视图并独立定位；提交开始时领票，离页或期间已导航则丢弃（F-376）
  const navigation = () =>
    guard((destination: ApplicationDestination) => {
      setParams({ view: destination.view });
      setPage(1);
      setFilters({});
      sorting.reset();
      locate(destination);
      result.refresh();
    });
  const changePage = (next: number) => {
    locate(undefined);
    setPage(next);
  };
  const applyFilters = (next: Filters) => {
    changePage(1);
    setFilters(next);
  };
  const open = (row: Row) => {
    locate(undefined);
    select({ view, row });
  };
  return {
    view,
    page,
    changePage,
    applyFilters,
    sorting,
    location,
    selected,
    close: () => select(undefined),
    open,
    allowed,
    result,
    items,
    switchView,
    located,
    refresh,
    navigation,
    create,
    createAllowed,
  };
}

function InternList() {
  const {
    view,
    page,
    changePage,
    applyFilters,
    sorting,
    location,
    selected,
    close,
    open,
    allowed,
    result,
    items,
    switchView,
    located,
    refresh,
    navigation,
    create,
    createAllowed,
  } = useInternList();
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
      {location && view === location.view && (
        <ApplicationLocation key={location.id} destination={location} onLocated={located} />
      )}
      <section className="intern-card">
        <FilterBar
          key={view}
          allowed={allowed}
          onApply={applyFilters}
          onRefresh={result.refresh}
          onCreate={createAllowed ? create.open : undefined}
        />
        {result.error ? (
          <PageState kind="error" error={result.error} retry={result.refresh} />
        ) : (
          <InternTable
            view={view}
            rows={items}
            loading={result.loading}
            noScope={result.data?.hasDataPermission === false}
            onOpen={open}
            sorting={sorting}
          />
        )}
        <div className="intern-pagination">
          <Button disabled={page === 1 || result.loading} onClick={() => changePage(page - 1)}>
            {m.previous}
          </Button>
          <span>{m.page(page)}</span>
          <Button disabled={items.length < pageSize || result.loading} onClick={() => changePage(page + 1)}>
            {m.next}
          </Button>
        </div>
      </section>
      <CreateIntern {...create.props} />
      {selected && (
        <InternDetail
          key={`${selected.view}/${selected.row.id}`}
          view={selected.view}
          row={selected.row}
          onClose={close}
          refresh={refresh}
          navigation={navigation}
        />
      )}
    </>
  );
}

function FilterBar({
  allowed,
  onApply,
  onRefresh,
  onCreate,
}: {
  allowed: (key: keyof Filters) => boolean;
  onApply(filters: Filters): void;
  onRefresh(): void;
  onCreate?: () => void;
}) {
  const [draft, setDraft] = useState<Filters>({});
  const apply = (next: Filters) => onApply(allowedFilters({ ...next, keyword: next.keyword?.trim() }, allowed));
  return (
    <Space className="intern-toolbar" wrap>
      {onCreate && (
        <Button type="primary" onClick={onCreate}>
          {c.title}
        </Button>
      )}
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
  institutionId: refPaths.institutionId,
  departmentId: refPaths.departmentId,
  positionId: refPaths.positionId,
  directManagerId: refPaths.directManagerId,
};
/** F-366：受控 sortOrder，表头显示的就是请求里的排序。 */
function sortColumn(key: string, sort: Sort | undefined) {
  const order = sort?.direction === 'desc' ? ('descend' as const) : ('ascend' as const);
  return { sorter: true, sortOrder: sort?.sortBy === key ? order : null };
}
type TableChange = NonNullable<TableProps<Row>['onChange']>;
function InternTable({
  view,
  rows,
  loading,
  noScope,
  onOpen,
  sorting: { sort, canSort, change, cancel },
}: {
  view: InternView;
  rows: Row[];
  loading: boolean;
  noScope: boolean;
  onOpen(row: Row): void;
  sorting: InternSorting;
}) {
  const changed: TableChange = (_, __, sorter, extra) => {
    if (extra.action !== 'sort') return;
    const picked = Array.isArray(sorter) ? sorter[0] : sorter;
    // 第三次点同列时 antd 回调的 columnKey、order 都是 undefined（受控单列排序下只会是当前列被取消），
    // 要先当取消处理；拿 String(undefined) 去过字段白名单会被拦掉，排序就停在降序（F-366 R1 P2-1）
    if (!picked?.order) return cancel();
    const key = String(picked.columnKey);
    if (canSort(key)) change(key);
  };
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
      onChange={changed}
      columns={[
        ...columns[view].map((key) => ({
          key,
          title: m.fields[key],
          ...(canSort(key) ? sortColumn(key, sort) : {}),
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

function useInternCreation(guard: NavigationGuard, onInterning: () => void) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const route = (receipt: CreateReceipt) => (receipt.view === 'pendingEntry' ? navigate('/entries') : onInterning());
  return {
    open: () => setOpen(true),
    props: {
      open,
      onClose: () => setOpen(false),
      // 保存开始时领票：回执迟到时页面已离开或已导航，只关弹窗、不再跳转（F-376）
      begin() {
        const go = guard(route);
        return (receipt: CreateReceipt) => {
          setOpen(false);
          go(receipt);
        };
      },
    },
  };
}
