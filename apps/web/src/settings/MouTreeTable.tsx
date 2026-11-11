import { Button, Empty, Input, Select, Space, Table, Tooltip } from 'antd';
import { useState, type Key, type ReactNode } from 'react';
import { ViewHeading } from '../foundation/ViewHeading.js';
import { PageState } from '../foundation/PageState.js';
import { ui } from '../foundation/messages.js';
import type { MouTreeNode } from './model.js';
import { m } from './messages.js';

export function MouTreeTable(props: {
  title: string;
  filters: { status: string; q: string };
  setFilters(filters: { status: string; q: string }): void;
  items: MouTreeNode[];
  loading: boolean;
  error?: unknown;
  retry(): void;
  detail(id: string): void;
  actions: ReactNode;
}) {
  const [expanded, setExpanded] = useState<Key[]>([]);
  const [selected, setSelected] = useState<Key[]>([]);
  const change = (filters: typeof props.filters) => {
    setExpanded([]);
    setSelected([]);
    props.setFilters(filters);
  };
  return (
    <section className="list-page settings-mou-tree">
      <header className="page-heading">
        <ViewHeading title={props.title} />
        <Space>{props.actions}</Space>
      </header>
      <div className="list-card">
        <MouFilters filters={props.filters} change={change} />
        {props.error ? (
          <PageState kind="error" error={props.error} retry={props.retry} />
        ) : (
          <Table<MouTreeNode>
            rowKey="id"
            dataSource={props.items}
            loading={props.loading}
            pagination={false}
            locale={{ emptyText: <Empty description={ui.empty} /> }}
            rowSelection={{ selectedRowKeys: selected, onChange: setSelected, columnWidth: '3%' }}
            expandable={{
              expandedRowKeys: expanded,
              onExpandedRowsChange: (keys) => setExpanded([...keys]),
              expandIcon: ({ expanded: open, record, onExpand }) =>
                record.children.length ? (
                  <Button
                    size="small"
                    type="text"
                    aria-label={open ? m.collapseMou : m.expandMou}
                    aria-expanded={open}
                    onClick={(event) => onExpand(record, event)}
                  >
                    {open ? '−' : '+'}
                  </Button>
                ) : (
                  <span className="settings-tree-leaf" />
                ),
            }}
            columns={mouColumns(props.detail)}
          />
        )}
      </div>
    </section>
  );
}

function mouColumns(detail: (id: string) => void) {
  return [
    {
      title: m.name,
      dataIndex: 'name',
      width: '23%',
      render: (name: string, row: MouTreeNode) => (
        <Button type="link" title={row.matched ? undefined : m.ancestorOnly} onClick={() => detail(row.id)}>
          {name}
        </Button>
      ),
    },
    { title: m.code, dataIndex: 'code', width: '23%' },
    { title: m.description, dataIndex: 'description', width: '40%' },
    {
      title: m.displayOrder,
      width: '8%',
      render: () => <Tooltip title={m.orderUnrecorded}>{m.empty}</Tooltip>,
    },
    { key: 'columns', title: '', width: '3%', render: () => <span aria-hidden>⚙</span> },
  ];
}

function MouFilters({
  filters,
  change,
}: {
  filters: { status: string; q: string };
  change(filters: { status: string; q: string }): void;
}) {
  const [search, setSearch] = useState('');
  return (
    <div className="page-filters" aria-label={ui.filter}>
      <Input.Search
        type="search"
        aria-label={m.mouSearch}
        placeholder={m.mouSearch}
        maxLength={100}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        onSearch={(value) => change({ ...filters, q: value.trim() })}
      />
      <Select
        aria-label={m.mouStatus}
        value={filters.status}
        onChange={(status: string) => change({ ...filters, status })}
        options={[
          { value: 'active', label: m.active },
          { value: 'disabled', label: m.disabled },
          { value: 'all', label: m.allStatuses },
        ]}
      />
      <Button
        onClick={() => {
          setSearch('');
          change({ status: 'active', q: '' });
        }}
      >
        {m.clear}
      </Button>
    </div>
  );
}
