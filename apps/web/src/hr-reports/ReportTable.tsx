import { Empty, Table } from 'antd';
import { useState, type ReactNode } from 'react';
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
  if (code === 'outflow')
    return tables.map((table) => (
      <OutflowTable key={table.key} table={table} paginationDisabled={paginationDisabled} />
    ));
  const roster = code === 'roster' && 'items' in data ? data : undefined;
  const organizationRowId = code === 'flow' ? '_organizationId' : undefined;
  return (
    <>
      {tables.map((table) => (
        <ReadOnlyReportTable
          key={table.key}
          table={table}
          rows={statistical(code) ? table.rows.slice((page - 1) * pageSize, page * pageSize) : table.rows}
          page={roster?.page ?? page}
          pageSize={roster?.pageSize ?? pageSize}
          rowId={roster ? 'employeeId' : organizationRowId}
          showEmptySummary={structureReport(code) || movement(code)}
          renderLabel={renderLabel}
          paginationDisabled={paginationDisabled}
          changePage={changePage}
        />
      ))}
    </>
  );
}

function OutflowTable({ table, paginationDisabled }: { table: DisplayTable; paginationDisabled?: boolean }) {
  // 设计 §4.7：流出按表键持有页码；重新查询时旧结果卸载，合计始终来自完整回执。
  const [page, changePage] = useState(1);
  return (
    <ReadOnlyReportTable
      table={table}
      rows={table.rows.slice((page - 1) * pageSize, page * pageSize)}
      page={page}
      pageSize={pageSize}
      changePage={changePage}
      paginationDisabled={paginationDisabled}
      showEmptySummary
    />
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
  scrollY,
  renderCell,
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
  scrollY?: number;
  renderCell?(key: string, value: unknown, row: Row): ReactNode;
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
            column.key === '_label' && renderLabel
              ? renderLabel(row)
              : (renderCell?.(column.key, value, row) ?? cellText(column.key, value)),
        }))}
        dataSource={rows.map((row, index) => ({ ...row, _rowKey: String(index) }))}
        rowKey={(row) => String((rowId && row[rowId]) || row._rowKey)}
        scroll={{ x: 'max-content', y: scrollY }}
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
