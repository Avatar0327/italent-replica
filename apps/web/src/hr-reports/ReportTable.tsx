import { Empty, Table } from 'antd';
import { m } from './messages.js';
import { cellText, pageSize, statistical, tablesOf, type ReportData, type Row } from './model.js';
export function ReportTable({
  code,
  data,
  page,
  changePage,
  paginationDisabled,
}: {
  code: string;
  data: ReportData;
  page: number;
  changePage(page: number): void;
  paginationDisabled?: boolean;
}) {
  // 空范围由后端明确告知，不从零值统计行反推权限或人数。
  if (data.hasDataPermission === false) return <Empty description={m.empty} />;
  const tables = tablesOf(code, data);
  const roster = code === 'roster' && 'items' in data ? data : undefined;
  return (
    <>
      {tables.map((table) => {
        const summary = table.summary;
        const rows = statistical(code) ? table.rows.slice((page - 1) * pageSize, page * pageSize) : table.rows;
        return (
          <section key={table.key} aria-label={table.name}>
            {table.name && <h2>{table.name}</h2>}
            <Table<Row>
              size="middle"
              columns={table.columns.map((column) => ({
                key: column.key,
                title: column.label,
                dataIndex: column.key,
                render: (value: unknown) => cellText(column.key, value),
              }))}
              dataSource={rows.map((row, index) => ({ ...row, _rowKey: String(index) }))}
              rowKey={(row) => String((roster && row.employeeId) || row._rowKey)}
              scroll={{ x: 'max-content' }}
              locale={{ emptyText: <Empty description={m.empty} /> }}
              pagination={{
                current: roster?.page ?? page,
                pageSize: roster?.pageSize ?? pageSize,
                total: table.total,
                disabled: paginationDisabled,
                showSizeChanger: false,
                showTotal: m.total,
                onChange: changePage,
                hideOnSinglePage: false,
              }}
              summary={
                summary && table.rows.length > 0
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
      })}
    </>
  );
}
