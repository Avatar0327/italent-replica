import { Button, Pagination } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageState } from '../foundation/PageState.js';
import { FiltersDrawer, useFilterPermission } from './Filters.js';
import { allowedFilters, listPath, views, type Filters, type ListResult, type View } from './model.js';
import { PartTimeTable } from './PartTimeTable.js';
import { PartTimeDetail, type Selection } from './PartTimeDetail.js';
import { useRead } from './useRead.js';
import { m } from './messages.js';
export function PartTimeList() {
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
  };
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
      <section className="part-time-card">
        <div className="part-time-toolbar">
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
