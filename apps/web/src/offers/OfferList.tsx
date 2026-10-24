import {
  Button,
  Dropdown,
  Empty,
  Input,
  Pagination,
  Popover,
  Select,
  Space,
  Table,
  Tooltip,
  type TableColumnsType,
} from 'antd';
import { useState } from 'react';
import { ViewHeading } from '../foundation/ViewHeading.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { ui } from '../foundation/messages.js';
import { useRead } from '../part-time/useRead.js';
import { OfferDetail } from './OfferDialogs.js';
import { m, toolbars, viewSpecs } from './messages.js';
import {
  actionLabels,
  displayValue,
  errorKind,
  filterFieldOf,
  filterOptions,
  listPath,
  object,
  openMail,
  pendingViews,
  readActions,
  visibleColumn,
  type Filters,
  type OfferListResult,
  type OfferRow,
  type View,
} from './model.js';

export function OfferList() {
  const session = useSession();
  return <OfferListReader key={`${session.tenantId}/${session.identityKey}`} />;
}
function OfferListReader() {
  const [view, setView] = useState<View>('pending');
  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<string>();
  const permission = usePermissions(object);
  const allowedFilters = Object.fromEntries(
    Object.entries(filters).filter(([field]) => permission.field(field).visible),
  );
  const result = useRead<OfferListResult>(listPath(view, page, allowedFilters));
  const rows = result.data?.items ?? [];
  const error = result.error ?? permission.error;
  const ready = !error && !result.loading && !permission.loading;
  const state = error ? <PageState kind={errorKind(error)} retry={result.refresh} /> : <PageState kind="loading" />;
  const switchView = (next: View) => {
    setView(next);
    setFilters({});
    setPage(1);
    setDetail(undefined);
  };
  const changeFilters = (next: Filters) => {
    setFilters(next);
    setPage(1);
  };
  const visible = (label: string) => visibleColumn(label, (field) => permission.field(field).visible, rows);
  const act = (row: OfferRow, key: string) => {
    if (key === 'viewMail') openMail(row.id);
    if (key === 'view') setDetail(row.id);
  };
  return (
    <>
      <OfferToolbar view={view} />
      <OfferViews view={view} switchView={switchView} />
      <section className="list-card">
        <OfferFilters rows={rows} view={view} filters={allowedFilters} setFilters={changeFilters} visible={visible} />
        {!ready ? (
          state
        ) : (
          <>
            <Table<OfferRow>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={rows}
              columns={offerColumns(view, visible, (row) => setDetail(row.id), act)}
              scroll={{
                x: viewSpecs
                  .find((v) => v.key === view)!
                  .columns.filter(([label]) => visible(label))
                  .reduce((sum, [, width]) => sum + width, 188),
              }}
              locale={{
                emptyText: <Empty description={result.data?.hasDataPermission === false ? ui.noScope : ui.empty} />,
              }}
            />
            <div className="page-toolbar">
              <span>{m.total(result.data?.total ?? 0)}</span>
              <Space>
                <span>{m.pageSize}</span>
                <Pagination
                  current={page}
                  pageSize={15}
                  total={result.data?.total ?? 0}
                  showSizeChanger={false}
                  onChange={setPage}
                />
              </Space>
            </div>
          </>
        )}
      </section>
      {detail && <OfferDetail key={detail} id={detail} close={() => setDetail(undefined)} />}
    </>
  );
}
function OfferToolbar({ view }: { view: View }) {
  return (
    <header className="page-heading">
      <ViewHeading title={m.title} />
      <Space wrap>
        {toolbars[view]?.map((label) => (
          <Button key={label} disabled>
            {label}
          </Button>
        ))}
      </Space>
    </header>
  );
}
function RowActions({ row, act }: { row: OfferRow; act(key: string): void }) {
  const { primary, menu } = readActions(row);
  const enabled = (key: string) => ['view', 'viewMail'].includes(key);
  return (
    <Space size={0}>
      {primary.map((key) => (
        <Button key={key} type="link" size="small" disabled={!enabled(key)} onClick={() => act(key)}>
          {actionLabels[key]}
        </Button>
      ))}
      {menu.length > 0 && (
        <Dropdown
          trigger={['click']}
          menu={{
            items: menu.map((key) => ({ key, label: actionLabels[key], disabled: !enabled(key) })),
            onClick: ({ key }) => act(key),
          }}
        >
          <Button size="small" type="link" aria-label={m.actions}>
            ▾
          </Button>
        </Dropdown>
      )}
    </Space>
  );
}
function offerColumns(
  view: View,
  visible: (label: string) => boolean,
  open: (row: OfferRow) => void,
  act: (row: OfferRow, key: string) => void,
) {
  const spec = viewSpecs.find((v) => v.key === view)!;
  const columns: TableColumnsType<OfferRow> = spec.columns
    .filter(([label]) => visible(label))
    .map(([label, width]) => ({
      title: label,
      key: label,
      width,
      ellipsis: true,
      render: (_, row) =>
        label === '姓名' ? (
          <Button type="link" onClick={() => open(row)}>
            {displayValue(row, label)}
          </Button>
        ) : (
          displayValue(row, label)
        ),
    }));
  columns.push(
    {
      title: m.operation,
      key: 'actions',
      width: 164,
      fixed: view === 'all' ? undefined : 'right',
      render: (_, row) => <RowActions row={row} act={(key) => act(row, key)} />,
    },
    {
      title: (
        <Tooltip title={m.columnSettings}>
          <span aria-label={m.columnSettings}>⚙</span>
        </Tooltip>
      ),
      key: 'gear',
      width: 24,
      fixed: 'right',
      render: () => null,
    },
  );
  return columns;
}
/** 每个数量直接取该视图未筛选读口的 total，不用本页条数推算。 */
function ViewCount({ view }: { view: View }) {
  const result = useRead<OfferListResult>(listPath(view, 1, {}, 1));
  return <strong>{result.data?.total ?? m.empty}</strong>;
}
function OfferViews({ view, switchView }: { view: View; switchView(view: View): void }) {
  const spec = viewSpecs.find((v) => v.key === view)!;
  return (
    <nav className="offer-views" aria-label={m.title}>
      <div className={`offer-view ${pendingViews.includes(view) ? 'offer-active' : ''}`}>
        <button aria-label={viewSpecs[0].label} aria-pressed={view === 'pending'} onClick={() => switchView('pending')}>
          <span>{viewSpecs[0].label}</span>
        </button>
        <div className="offer-pending-summary">
          <ViewCount view={pendingViews.includes(view) ? view : 'pending'} />
          <Dropdown
            trigger={['click']}
            menu={{
              items: viewSpecs.slice(0, 4).map((v) => ({ key: v.key, label: v.label })),
              onClick: ({ key }) => switchView(key),
              selectedKeys: [view],
            }}
          >
            <Button size="small" type="text" aria-label="待发二级视图">
              {pendingViews.includes(view) ? spec.label : viewSpecs[0].label} ▾
            </Button>
          </Dropdown>
        </div>
      </div>
      {viewSpecs.slice(4).map((v) => (
        <div key={v.key} className={`offer-view ${view === v.key ? 'offer-active' : ''}`}>
          <button aria-label={v.label} aria-pressed={view === v.key} onClick={() => switchView(v.key)}>
            <span>{v.label}</span>
            <ViewCount view={v.key} />
          </button>
        </div>
      ))}
    </nav>
  );
}
function OfferFilters({
  rows,
  view,
  filters,
  setFilters,
  visible,
}: {
  rows: OfferRow[];
  view: View;
  filters: Filters;
  setFilters(next: Filters): void;
  visible(label: string): boolean;
}) {
  const spec = viewSpecs.find((v) => v.key === view)!;
  return (
    <div className="page-filters">
      <Space wrap>
        {spec.filters
          .filter((label) => filterFieldOf(view, label) && visible(label))
          .map((label) => {
            const field = filterFieldOf(view, label)!;
            const selected = filters[field];
            return (
              <Popover
                key={label}
                trigger="click"
                content={
                  ['姓名', '个人邮箱'].includes(label) ? (
                    <Input
                      aria-label={label}
                      value={selected?.value ?? ''}
                      allowClear
                      onChange={(e) =>
                        setFilters({ ...filters, [field]: { value: e.target.value, label: e.target.value } })
                      }
                    />
                  ) : (
                    <Select
                      aria-label={label}
                      labelInValue
                      value={selected?.value ? selected : undefined}
                      allowClear
                      className="offer-filter-select"
                      options={filterOptions(rows, label)}
                      onChange={(value) => {
                        const next = { ...filters };
                        if (value) next[field] = { value: String(value.value), label: String(value.label) };
                        else delete next[field];
                        setFilters(next);
                      }}
                    />
                  )
                }
              >
                <Button type="text">
                  {label}
                  {selected?.value ? `：${selected.label}` : ''} ▾
                </Button>
              </Popover>
            );
          })}
        {Object.values(filters).some((v) => v.value) && (
          <Button type="link" onClick={() => setFilters({})}>
            {m.clear}
          </Button>
        )}
      </Space>
    </div>
  );
}
