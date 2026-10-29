import { Button, Pagination } from 'antd';
import { useSearchParams } from 'react-router';
import { PageState } from '../foundation/PageState.js';
import { useToday } from '../contracts/references.js';
import { FiltersDrawer, QuickFilters, hasAdvancedFilters, useFilterPermission, useSortPermission } from './Filters.js';
import { allowedFilters, listPath, views, type Filters, type ListResult, type Sort, type View } from './model.js';
import { PartTimeTable } from './PartTimeTable.js';
import { PartTimeDetail, type Selection } from './PartTimeDetail.js';
import { useRead } from './useRead.js';
import { useDirectAccess } from './direct-commands.js';
import { DirectForm, DirectEdit } from './DirectForm.js';
import { DirectBatch } from './DirectBatch.js';
import { d } from './direct-messages.js';
import type { Row } from './model.js';
import { RequestEntries, NewRequestButton } from './RequestEntries.js';
import { m } from './messages.js';
import { useViewState } from './list-state.js';
function useList() {
  const access = useDirectAccess();
  const [params, setParams] = useSearchParams();
  const view = views.find((item) => item.key === params.get('view'))?.key ?? 'ongoing';
  const { state, patch, reset } = useViewState(view);
  const { page, filters, sort } = state;
  const allowed = useFilterPermission();
  const canSort = useSortPermission(view);
  const projectedSort = sort && canSort(sort.sortBy) ? sort : undefined;
  const projected = allowedFilters(filters, allowed, view);
  const today = useToday();
  const result = useRead<ListResult>(listPath(view, page, projected, 30, projectedSort, today));
  return {
    ...state,
    access,
    check: (checked: Row[]) => patch({ checked }),
    setDirect: (direct?: string) => patch({ direct }),
    async refreshDirect() {
      await result.reload();
    },
    setPage: (page: number) => patch({ page }),
    setDrawer: (drawer: boolean) => patch({ drawer }),
    select: (selected?: Selection) => patch({ selected }),
    allowed,
    canSort,
    sort: projectedSort,
    onSort(next?: Sort) {
      patch({ sort: next, page: 1, checked: [] });
    },
    projected,
    result,
    switchView(next: View) {
      if (next === view) reset();
      setParams({ view: next });
    },
    applyFilters(next: Filters) {
      patch({ filters: allowedFilters(next, allowed, view), page: 1, checked: [] });
    },
  };
}
type State = ReturnType<typeof useList>;
export function PartTimeList() {
  const state = useList();
  const { view, drawer, setDrawer, selected, select, allowed, projected, result, switchView } = state;
  return (
    <RequestEntries refresh={result.reload} saved={(id) => select({ id, request: true })}>
      <h1>{m.title}</h1>
      <nav className="part-time-views" aria-label={m.title}>
        {views.map((item) => (
          <button
            key={item.key}
            aria-label={item.label}
            aria-pressed={view === item.key}
            onClick={() => switchView(item.key)}
          >
            <span>{item.label}</span>
            {view === item.key && <strong>{result.data?.total ?? m.missing}</strong>}
          </button>
        ))}
      </nav>
      <ListCard state={state} />
      <DirectDialogs state={state} />
      {drawer && (
        <FiltersDrawer
          initial={projected}
          view={view}
          allowed={allowed}
          onClose={() => setDrawer(false)}
          onApply={(next) => {
            state.applyFilters(next);
            setDrawer(false);
          }}
        />
      )}
      {selected && (
        <PartTimeDetail
          key={`${selected.request}/${selected.id}`}
          selected={selected}
          onSelect={select}
          onClose={() => select(undefined)}
        />
      )}
    </RequestEntries>
  );
}

function ListCard({ state }: { state: State }) {
  const { view, setDrawer, select, result } = state;
  return (
    <section className="part-time-card">
      <div className="part-time-toolbar">
        {state.access.p.can('Employment.PartTime') && (
          <Button type="primary" disabled={!state.access.operation(true)} onClick={() => state.setDirect('create')}>
            {d.add}
          </Button>
        )}
        {view !== 'in_approval' && state.access.p.can('Employment.PartTimeBatchEnd', 'list') && (
          <Button
            disabled={
              !state.access.field('endDate', false).editable || !state.checked.length || state.checked.length > 200
            }
            onClick={() => state.setDirect('batch')}
          >
            {d.batch}
          </Button>
        )}
        <NewRequestButton />
        {hasAdvancedFilters(view) && <Button onClick={() => setDrawer(true)}>{m.filter}</Button>}
        <Button type="text" onClick={() => state.applyFilters({})}>
          {m.reset}
        </Button>
        <Button onClick={result.refresh}>{m.refresh}</Button>
      </div>
      <QuickFilters
        key={`${view}/${JSON.stringify(state.projected)}`}
        initial={state.projected}
        view={view}
        allowed={state.allowed}
        onApply={state.applyFilters}
      />
      {result.error ? (
        <PageState kind="error" error={result.error} retry={result.refresh} />
      ) : (
        <>
          <PartTimeTable
            rows={result.data?.items ?? []}
            selection={
              view !== 'in_approval' && state.access.p.can('Employment.PartTimeBatchEnd', 'list')
                ? { keys: state.checked.map((row) => row.id), onChange: state.check }
                : undefined
            }
            actions={
              view !== 'in_approval' && state.access.p.can('Employment.PartTimeEdit')
                ? (row) => (
                    <Button
                      type="link"
                      disabled={!state.access.operation(false)}
                      onClick={() => state.setDirect(row.id)}
                    >
                      {d.edit.replace('兼职', '')}
                    </Button>
                  )
                : undefined
            }
            view={view}
            {...{ sort: state.sort, canSort: state.canSort, onSort: state.onSort }}
            loading={result.loading}
            noScope={result.data?.hasDataPermission === false}
            onOpen={(row) => select({ id: row.id, request: view === 'in_approval' })}
          />
          <ListPagination state={state} />
        </>
      )}
    </section>
  );
}

function DirectDialogs({ state }: { state: State }) {
  return (
    <>
      {state.direct === 'create' && (
        <DirectForm
          onClose={() => {
            state.setDirect(undefined);
            state.check([]);
          }}
          refresh={state.refreshDirect}
        />
      )}
      {state.direct === 'batch' && (
        <DirectBatch
          rows={state.checked}
          onClose={() => {
            state.setDirect(undefined);
            state.check([]);
          }}
          refresh={state.refreshDirect}
        />
      )}
      {state.direct && !['create', 'batch'].includes(state.direct) && (
        <DirectEdit
          id={state.direct}
          onClose={() => {
            state.setDirect(undefined);
            state.check([]);
          }}
          refresh={state.refreshDirect}
        />
      )}
    </>
  );
}

function ListPagination({ state }: { state: State }) {
  const { page, setPage, result } = state;
  return (
    <div className="part-time-pagination">
      <span>{m.total(result.data?.total ?? 0)}</span>
      <Pagination
        current={page}
        pageSize={30}
        showSizeChanger={false}
        total={result.data?.total ?? 0}
        disabled={result.loading}
        onChange={setPage}
      />
    </div>
  );
}
