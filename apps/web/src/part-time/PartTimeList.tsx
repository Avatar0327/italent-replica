import { Button, Pagination } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageState } from '../foundation/PageState.js';
import { FiltersDrawer, useFilterPermission } from './Filters.js';
import { allowedFilters, listPath, views, type Filters, type ListResult, type View } from './model.js';
import { PartTimeTable } from './PartTimeTable.js';
import { PartTimeDetail, type Selection } from './PartTimeDetail.js';
import { useRead } from './useRead.js';
import { useDirectAccess } from './direct-commands.js';
import { DirectForm, DirectEdit } from './DirectForm.js';
import { DirectBatch } from './DirectBatch.js';
import { d } from './direct-messages.js';
import type { Row } from './model.js';
import { m } from './messages.js';
function useList() {
  const access = useDirectAccess();
  const [checked, check] = useState<Row[]>([]);
  const [direct, setDirect] = useState<string>();
  const [params, setParams] = useSearchParams();
  const view = views.find((item) => item.key === params.get('view'))?.key ?? 'ongoing';
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({});
  const [days, setDays] = useState(30);
  const [drawer, setDrawer] = useState(false);
  const [selected, select] = useState<Selection>();
  const allowed = useFilterPermission();
  const projected = allowedFilters(filters, allowed);
  const result = useRead<ListResult>(listPath(view, page, projected, days));
  const switchView = (next: View) => {
    setParams({ view: next });
    setPage(1);
    setFilters({});
    select(undefined);
    check([]);
    setDirect(undefined);
  };
  return {
    access,
    checked,
    check,
    direct,
    setDirect,
    async refreshDirect() {
      await result.reload();
    },
    view,
    page,
    setPage,
    filters,
    setFilters,
    days,
    setDays,
    drawer,
    setDrawer,
    selected,
    select,
    allowed,
    projected,
    result,
    switchView,
  };
}
type State = ReturnType<typeof useList>;
export function PartTimeList() {
  const state = useList();
  const {
    view,
    days,
    setDays,
    setPage,
    setFilters,
    drawer,
    setDrawer,
    selected,
    select,
    allowed,
    projected,
    result,
    switchView,
  } = state;
  return (
    <>
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
          days={days}
          view={view}
          allowed={allowed}
          onClose={() => setDrawer(false)}
          onApply={(next, nextDays) => {
            setFilters(allowedFilters(next, allowed));
            setDays(nextDays);
            setPage(1);
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
    </>
  );
}

// TODO(需取证 #447)：批量按钮目录为 list，API 当前验 detail；等待独立契约修复。
function ListCard({ state }: { state: State }) {
  const { view, page, setPage, setFilters, setDays, setDrawer, select, result } = state;
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
        <Button onClick={() => setDrawer(true)}>{m.filter}</Button>
        <Button
          type="text"
          onClick={() => {
            setFilters({});
            setPage(1);
            setDays(30);
          }}
        >
          {m.reset}
        </Button>
        <Button onClick={result.refresh}>{m.refresh}</Button>
      </div>
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
            loading={result.loading}
            noScope={result.data?.hasDataPermission === false}
            onOpen={(row) => select({ id: row.id, request: view === 'in_approval' })}
          />
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
