import type { ReactNode } from 'react';
import { Button, Table } from 'antd';
import { columnKeys, columnWidth, type Row, type View } from './model.js';
import { Cell } from './references.js';
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
}: {
  rows: Row[];
  view: View;
  loading: boolean;
  noScope?: boolean;
  profile?: boolean;
  onOpen(row: Row): void;
  actions?: (row: Row) => ReactNode;
  selection?: { keys: string[]; onChange(rows: Row[]): void };
}) {
  const keys = columnKeys(view).filter((key) => !profile || !['name', 'code'].includes(key));
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
      columns={[
        ...keys.map((key) => ({
          key,
          title: m.fields[key],
          width: columnWidth(view, key),
          ellipsis: true,
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
            </>
          ),
        },
      ]}
    />
  );
}
