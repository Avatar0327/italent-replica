import type { ReactNode } from 'react';

export interface EmploymentColumn {
  readonly key: string;
  readonly label: string;
}
export interface EmploymentListProps<Row extends Readonly<Record<string, unknown>>> {
  readonly items: readonly Row[];
  readonly columns: readonly EmploymentColumn[];
  readonly renderCell?: (row: Row, key: string) => ReactNode;
}
/** 自助任职 / 团队成员只读列表。操作入口由所在页面单独提供，不注入行操作。 */
export function EmploymentList<Row extends Readonly<Record<string, unknown>>>({
  items,
  columns,
  renderCell = (row, key) => String(row[key] ?? '—'),
}: EmploymentListProps<Row>) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((row, index) => (
            <tr key={String(row.id ?? index)}>
              {columns.map((column) => (
                <td key={column.key}>{renderCell(row, column.key)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
