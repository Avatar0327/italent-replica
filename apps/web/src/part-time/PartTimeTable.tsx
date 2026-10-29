import type { ReactNode } from 'react';
import { Button, Table, type TableProps } from 'antd';
import { columnKeys, columnWidth, type Row, type Sort, type SortKey, type View } from './model.js';
import { Cell } from './references.js';
import { DateRequestButtons } from './RequestEntries.js';
import { m } from './messages.js';
export function PartTimeTable({
  rows,
  view,
  loading,
  noScope,
  profile,
  onOpen,
  actions,
  selection,
  sort,
  canSort,
  onSort,
}: {
  rows: Row[];
  view: View;
  loading: boolean;
  noScope?: boolean;
  profile?: boolean;
  onOpen(row: Row): void;
  actions?: (row: Row) => ReactNode;
  selection?: { keys: string[]; onChange(rows: Row[]): void };
  sort?: Sort;
  canSort?: (key: string) => boolean;
  onSort?: (sort?: Sort) => void;
}) {
  const keys = columnKeys(view).filter((key) => !profile || !['name', 'code'].includes(key));
  const active = sort ?? { sortBy: 'effectiveDate', direction: view === 'expiring' ? 'asc' : 'desc' };
  return (
    <Table<Row>
      className="part-time-table"
      size="small"
      pagination={false}
      loading={loading}
      rowKey="id"
      rowSelection={
        selection ? { selectedRowKeys: selection.keys, onChange: (_, rows) => selection.onChange(rows) } : undefined
      }
      dataSource={rows}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: noScope ? m.noScope : m.empty }}
      onChange={(_, __, selected) => changeSort(selected, canSort, onSort)}
      columns={[
        ...keys.map((key) => ({
          key,
          title: m.fields[key],
          width: columnWidth(view, key),
          ellipsis: true,
          ...(onSort && canSort?.(key) ? sortColumn(key, active) : {}),
          render: (_: unknown, row: Row) => <Cell row={row} field={key} view={view} />,
        })),
        {
          key: 'operation',
          title: m.operation,
          width: columnWidth(view, 'operation'),
          fixed: 'right' as const,
          render: (_: unknown, row: Row) => (
            <>
              {actions?.(row)}
              <Button type="link" onClick={() => onOpen(row)}>
                {m.open}
              </Button>
              {!profile && view !== 'in_approval' && <DateRequestButtons row={row} />}
            </>
          ),
        },
      ]}
    />
  );
}

function sortColumn(key: string, active: { sortBy: string; direction: string }) {
  const direction = active.direction === 'asc' ? ('ascend' as const) : ('descend' as const);
  return { sorter: true, sortOrder: active.sortBy === key ? direction : null };
}
function changeSort(
  selected: Parameters<NonNullable<TableProps<Row>['onChange']>>[2],
  allowed?: (key: string) => boolean,
  onSort?: (sort?: Sort) => void,
) {
  const next = Array.isArray(selected) ? selected[0] : selected;
  const key = String(next?.columnKey);
  if (allowed?.(key))
    onSort?.(
      next?.order
        ? {
            sortBy: key as SortKey,
            direction: next.order === 'ascend' ? 'asc' : 'desc',
          }
        : undefined,
    );
}
