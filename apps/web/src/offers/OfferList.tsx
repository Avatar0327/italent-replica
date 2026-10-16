import {
  Button,
  Dropdown,
  Input,
  Pagination,
  Popover,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  type TableColumnsType,
} from 'antd';
import { useState, type Key, type Dispatch, type SetStateAction } from 'react';
import { offerExamples, type OfferExample } from '../demo-stubs/offers.js';
import { ViewHeading } from '../foundation/ViewHeading.js';
import { OfferDetail, OfferDialog } from './OfferDialogs.js';
import { m, toolbars, viewSpecs } from './messages.js';
import { displayValue, filterOffers, inView, pendingViews, rowActions, type DemoAction, type View } from './model.js';

export function OfferList() {
  const [rows] = useState(offerExamples);
  const [view, setView] = useState<View>('pending');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Key[]>([]);
  const [detail, setDetail] = useState<OfferExample>();
  const [dialog, setDialog] = useState<{ row: OfferExample; action: DemoAction }>();
  const filtered = filterOffers(rows, view, filters);
  const shown = filtered.slice((page - 1) * 15, page * 15);
  const switchView = (next: View) => {
    setView(next);
    setFilters({});
    setPage(1);
    setSelected([]);
  };
  const act = (row: OfferExample, label: string) => {
    if (label === m.transfer || label === m.invalidate)
      setDialog({ row, action: label === m.transfer ? 'transfer' : 'invalidate' });
  };
  const changeFilters = (next: Record<string, string>) => {
    setFilters(next);
    setPage(1);
    setSelected([]);
  };
  const selectedRow = selected.length === 1 ? shown.find((r) => r.id === selected[0]) : undefined;
  return (
    <>
      <OfferToolbar view={view} selectedRow={selectedRow} act={act} />
      <OfferViews rows={rows} view={view} switchView={switchView} />
      <section className="list-card">
        <OfferFilters rows={rows} view={view} filters={filters} setFilters={changeFilters} />
        <OfferTable
          rows={shown}
          view={view}
          setDetail={setDetail}
          act={act}
          selected={selected}
          setSelected={setSelected}
          page={page}
          total={filtered.length}
          changePage={(next) => {
            setPage(next);
            setSelected([]);
          }}
        />
      </section>
      {detail && <OfferDetail row={detail} close={() => setDetail(undefined)} />}
      {dialog && (
        <OfferDialog key={`${dialog.row.id}/${dialog.action}`} {...dialog} close={() => setDialog(undefined)} />
      )}
    </>
  );
}
function RowActions({ row, view, act }: { row: OfferExample; view: View; act(label: string): void }) {
  const { primary, menu } = rowActions(row, view);
  const enabled = (label: string) => [m.transfer, m.invalidate].includes(label);
  return (
    <Space size={0}>
      {primary.map((label) => (
        <Button key={label} type="link" size="small" disabled={!enabled(label)} onClick={() => act(label)}>
          {label}
        </Button>
      ))}
      {menu.length > 0 && (
        <Dropdown
          trigger={['click']}
          menu={{
            items: menu.map((label) => ({ key: label, label, disabled: !enabled(label) })),
            onClick: ({ key }) => act(key),
          }}
        >
          <Button size="small" type="link" aria-label={m.actions}>
            ▾
          </Button>
        </Dropdown>
      )}
      {row.overCapacity && <Tag color="orange">{m.overCapacity}</Tag>}
    </Space>
  );
}

type Act = (row: OfferExample, label: string) => void;
function offerColumns(view: View, setDetail: (row: OfferExample) => void, act: Act) {
  const spec = viewSpecs.find((v) => v.key === view)!;
  const columns: TableColumnsType<OfferExample> = spec.columns.map(([label, width]) => ({
    title: (
      <>
        {label}
        {view === 'pending' && ['录用部门', '预计入职日期'].includes(label) && <span aria-hidden="true"> ↕</span>}
      </>
    ),
    key: label,
    width,
    ellipsis: true,
    render: (_, row) =>
      label === '姓名' ? (
        <Button type="link" onClick={() => setDetail(row)}>
          {row.name}
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
      render: (_, row) => <RowActions row={row} view={view} act={(label) => act(row, label)} />,
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

function OfferToolbar({ view, selectedRow, act }: { view: View; selectedRow?: OfferExample; act: Act }) {
  return (
    <header className="page-heading">
      <ViewHeading title={m.title} />
      <Space wrap>
        {toolbars[view]!.map((label) =>
          label === m.newIntern ? (
            <Dropdown
              key={label}
              trigger={['hover']}
              menu={{ items: m.internEntries.map((entry) => ({ key: entry, label: entry, disabled: true })) }}
            >
              <span tabIndex={0}>
                <Button disabled>{label} ▾</Button>
              </span>
            </Dropdown>
          ) : label === m.transfer ? (
            <Tooltip key={label} title={m.batchSingle}>
              <Button type="primary" disabled={!selectedRow} onClick={() => selectedRow && act(selectedRow, label)}>
                {label}
              </Button>
            </Tooltip>
          ) : (
            <Button key={label} disabled>
              {label}
            </Button>
          ),
        )}
      </Space>
    </header>
  );
}

function OfferViews({ rows, view, switchView }: { rows: OfferExample[]; view: View; switchView(view: View): void }) {
  const spec = viewSpecs.find((v) => v.key === view)!;
  return (
    <nav className="offer-views" aria-label={m.title}>
      <div className={`offer-view ${pendingViews.includes(view) ? 'offer-active' : ''}`}>
        <button aria-label={viewSpecs[0].label} aria-pressed={view === 'pending'} onClick={() => switchView('pending')}>
          <span>{viewSpecs[0].label}</span>
        </button>
        <div className="offer-pending-summary">
          <strong>{rows.filter((r) => inView(r, pendingViews.includes(view) ? view : 'pending')).length}</strong>
          <Dropdown
            trigger={['click']}
            menu={{
              items: viewSpecs.slice(0, 4).map((v) => ({ key: v.key, label: v.label })),
              onClick: ({ key }) => switchView(key as View),
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
            <strong>{rows.filter((r) => inView(r, v.key)).length}</strong>
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
}: {
  rows: OfferExample[];
  view: View;
  filters: Record<string, string>;
  setFilters(next: Record<string, string>): void;
}) {
  const spec = viewSpecs.find((v) => v.key === view)!;
  return (
    <div className="page-filters">
      <Space wrap>
        {spec.filters.map((label) => (
          <Popover
            key={label}
            trigger="click"
            content={
              ['姓名', '个人邮箱'].includes(label) ? (
                <Input
                  aria-label={label}
                  value={filters[label] ?? ''}
                  allowClear
                  onChange={(e) => {
                    setFilters({ ...filters, [label]: e.target.value });
                  }}
                />
              ) : (
                <Select
                  aria-label={label}
                  value={filters[label] || undefined}
                  allowClear
                  className="offer-filter-select"
                  options={[...new Set(rows.filter((r) => inView(r, view)).map((r) => displayValue(r, label)))].map(
                    (value) => ({ value, label: value }),
                  )}
                  onChange={(value) => {
                    setFilters({ ...filters, [label]: value ?? '' });
                  }}
                />
              )
            }
          >
            <Button type="text">
              {label}
              {filters[label] ? `：${filters[label]}` : ''} ▾
            </Button>
          </Popover>
        ))}
        {Object.values(filters).some(Boolean) && (
          <Button
            type="link"
            onClick={() => {
              setFilters({});
            }}
          >
            {m.clear}
          </Button>
        )}
        {view === 'approving' && (
          <Button type="link" disabled>
            {m.advanced}
          </Button>
        )}
      </Space>
    </div>
  );
}

function OfferTable({
  rows,
  view,
  setDetail,
  act,
  selected,
  setSelected,
  page,
  total,
  changePage,
}: {
  rows: OfferExample[];
  view: View;
  setDetail(row: OfferExample): void;
  act: Act;
  selected: Key[];
  setSelected: Dispatch<SetStateAction<Key[]>>;
  page: number;
  total: number;
  changePage(page: number): void;
}) {
  return (
    <>
      <Table
        rowKey="id"
        size="small"
        columns={offerColumns(view, setDetail, act)}
        dataSource={rows}
        pagination={false}
        scroll={{
          x:
            viewSpecs.find((v) => v.key === view)!.columns.reduce((sum, [, width]) => sum + width, 188) +
            (['all', 'invalid'].includes(view) ? 0 : 38),
        }}
        rowSelection={
          ['all', 'invalid'].includes(view)
            ? undefined
            : { columnWidth: 38, selectedRowKeys: selected, onChange: setSelected }
        }
      />
      <div className="page-toolbar">
        <span>{m.total(total)}</span>
        <Space>
          <span>{m.pageSize}</span>
          <Pagination current={page} pageSize={15} total={total} showSizeChanger={false} onChange={changePage} />
        </Space>
      </div>
    </>
  );
}
