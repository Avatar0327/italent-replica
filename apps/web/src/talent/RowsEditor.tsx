import { text } from './messages.js';

export interface Column<Row> {
  readonly key: keyof Row & string;
  readonly label: string;
  readonly kind?: 'text' | 'number' | 'textarea' | 'select';
  readonly required?: boolean;
  /** kind = select 时的选项（如发展建议类型下拉）。 */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

/** 明细行编辑（等级 / 行为 / 发展建议 / 面试问题）：整组提交，服务端整组替换；发展建议子表的增删改都经这里。 */
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
                  <Cell
                    column={column}
                    value={row[column.key]}
                    onChange={(value) => update(index, column.key, value)}
                  />
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

/** 一个明细单元格：下拉 / 多行文本 / 数字 / 单行文本。 */
function Cell<Row>({
  column,
  value,
  onChange,
}: {
  column: Column<Row>;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const shown = String(value ?? '');
  if (column.kind === 'select') {
    return (
      <select
        aria-label={column.label}
        required={column.required}
        value={shown}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{text.chooseType}</option>
        {(column.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (column.kind === 'textarea') {
    return (
      <textarea
        aria-label={column.label}
        required={column.required}
        maxLength={4000}
        value={shown}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  }
  return (
    <input
      aria-label={column.label}
      type={column.kind === 'number' ? 'number' : 'text'}
      required={column.required}
      value={shown}
      onChange={(e) => onChange(column.kind === 'number' ? Number(e.target.value) : e.target.value || null)}
    />
  );
}
