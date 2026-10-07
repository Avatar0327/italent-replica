import { text } from './messages.js';

export interface Column<Row> {
  readonly key: keyof Row & string;
  readonly label: string;
  readonly kind?: 'text' | 'number' | 'textarea';
  readonly required?: boolean;
}

/** 明细行编辑（等级 / 行为 / 发展建议 / 面试问题）：整组提交，服务端整组替换。 */
export function RowsEditor<Row extends Record<string, unknown>>({
  legend,
  columns,
  rows,
  blank,
  onChange,
}: {
  legend: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  blank: () => Row;
  onChange: (rows: Row[]) => void;
}) {
  const update = (index: number, key: string, value: unknown) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  return (
    <fieldset>
      <legend>{legend}</legend>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key}>
                  {column.kind === 'textarea' ? (
                    <textarea
                      aria-label={column.label}
                      required={column.required}
                      maxLength={4000}
                      value={String(row[column.key] ?? '')}
                      onChange={(event) => update(index, column.key, event.target.value || null)}
                    />
                  ) : (
                    <input
                      aria-label={column.label}
                      type={column.kind === 'number' ? 'number' : 'text'}
                      required={column.required}
                      value={String(row[column.key] ?? '')}
                      onChange={(event) =>
                        update(
                          index,
                          column.key,
                          column.kind === 'number' ? Number(event.target.value) : event.target.value || null,
                        )
                      }
                    />
                  )}
                </td>
              ))}
              <td>
                <button type="button" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
                  {text.remove}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => onChange([...rows, blank()])}>
        {text.addRow}
      </button>
    </fieldset>
  );
}
