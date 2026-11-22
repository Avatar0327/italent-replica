import { Empty, Table } from 'antd';
import type { ReactNode } from 'react';
import { m } from './messages.js';
import {
  cellText,
  movement,
  pageSize,
  statistical,
  structureReport,
  tablesOf,
  type DisplayTable,
  type ReportData,
  type Row,
} from './model.js';
export function ReportTable({
  code,
  data,
  page,
  changePage,
  paginationDisabled,
  drilled,
  renderLabel,
}: {
  code: string;
  data: ReportData;
  paginationDisabled?: boolean;
  drilled?: boolean;
  renderLabel?(row: Row): ReactNode;
  page: number;
  changePage(page: number): void;
}) {
  // 空范围由后端明确告知，不从零值统计行反推权限或人数。
  if (data.hasDataPermission === false) return <Empty description={m.empty} />;
  const tables = tablesOf(code, data, drilled);
  const roster = code === 'roster' && 'items' in data ? data : undefined;
  return (
    <>
      {tables.map((table) => (
        <ReadOnlyReportTable
          key={table.key}
          table={table}
          rows={statistical(code) ? table.rows.slice((page - 1) * pageSize, page * pageSize) : table.rows}
          page={roster?.page ?? page}
          pageSize={roster?.pageSize ?? pageSize}
          rowId={roster ? 'employeeId' : code === 'flow' ? '_organizationId' : undefined}
          showEmptySummary={structureReport(code) || movement(code)}
          renderLabel={renderLabel}
          paginationDisabled={paginationDisabled}
          changePage={changePage}
        />
      ))}
    </>
  );
}

export function ReadOnlyReportTable({
  table,
  rows = table.rows,
  page,
  pageSize,
  changePage,
  emptyText = m.empty,
  rowId,
  showEmptySummary,
  paginationDisabled,
  renderLabel,
}: {
  table: DisplayTable;
  rows?: Row[];
  page: number;
  pageSize: number;
  changePage(page: number): void;
  emptyText?: string;
  rowId?: string;
  showEmptySummary?: boolean;
  paginationDisabled?: boolean;
  renderLabel?(row: Row): ReactNode;
}) {
  const summary = table.summary;
  return (
    <section aria-label={table.name}>
      {table.name && <h2>{table.name}</h2>}
      <Table<Row>
        size="middle"
        columns={table.columns.map((column) => ({
          key: column.key,
          title: column.label,
          dataIndex: column.key,
          render: (value: unknown, row) =>
            column.key === '_label' && renderLabel ? renderLabel(row) : cellText(column.key, value),
        }))}
        dataSource={rows.map((row, index) => ({ ...row, _rowKey: String(index) }))}
        rowKey={(row) => String((rowId && row[rowId]) || row._rowKey)}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty description={emptyText} /> }}
        pagination={{
          current: page,
          pageSize,
          total: table.total,
          disabled: paginationDisabled,
          showSizeChanger: false,
          showTotal: m.total,
          onChange: changePage,
          hideOnSinglePage: false,
        }}
        summary={
          summary && (table.rows.length > 0 || showEmptySummary)
            ? () => (
                <Table.Summary.Row>
                  {table.columns.map((column, index) => (
                    <Table.Summary.Cell index={index} key={column.key}>
                      {cellText(column.key, summary[column.key])}
                    </Table.Summary.Cell>
                  ))}
                </Table.Summary.Row>
              )
            : undefined
        }
      />
    </section>
  );
}
