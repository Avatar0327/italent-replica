// 数据行：勾选、顺序、各条件列 / 角色列、操作（添加 / 复制 / 删除，原站 docs/02_业务建模/30 「### F-326」；
// 上移 / 下移是本片补的调序入口，原站调序方式未取证）。所有操作只改本地草稿，保存时一次 PUT。
import { MATRIX_LIMITS } from '@italent/domain';
import { Button, Space, Table } from 'antd';
import { CellPicker, type Labels } from './CellPicker.js';
import { sm } from './structure-messages.js';
import { kindOf, newRef, type DraftColumn, type DraftRow, type Structure } from './structure-model.js';

type Update = (change: (structure: Structure) => Structure) => void;
const ROW_PAGE_SIZE = 50;
const emptyRow = (columns: DraftColumn[]): DraftRow => ({
  ref: newRef(),
  id: null,
  cells: Object.fromEntries(columns.map((column) => [column.ref, []])),
});
const withRows = (change: (rows: DraftRow[], structure: Structure) => DraftRow[]) => (structure: Structure) => ({
  ...structure,
  rows: change([...structure.rows], structure),
});
export const addRow = withRows((rows, { columns }) => [...rows, emptyRow(columns)]);
export const removeRows = (refs: ReadonlySet<string>) => withRows((rows) => rows.filter((row) => !refs.has(row.ref)));
const insertAfter = (index: number, copy: boolean) =>
  withRows((rows, { columns }) => {
    const source = rows[index]!;
    rows.splice(
      index + 1,
      0,
      copy ? { ref: newRef(), id: null, cells: structuredClone(source.cells) } : emptyRow(columns),
    );
    return rows;
  });
const move = (index: number, offset: number) =>
  withRows((rows) => {
    [rows[index], rows[index + offset]] = [rows[index + offset]!, rows[index]!];
    return rows;
  });

const cellMax = (column: DraftColumn) => {
  if (column.kind === 'condition') return MATRIX_LIMITS.conditionCellIds;
  return column.allowMultiple ? MATRIX_LIMITS.roleCellIds : 1;
};
type Props = {
  structure: Structure;
  invalid: ReadonlySet<string>;
  readonly: boolean;
  locked: boolean;
  full: boolean;
  labels: Labels;
  selected: string[];
  select(refs: string[]): void;
  update: Update;
};

function Operations({ index, last, row, props }: { index: number; last: number; row: DraftRow; props: Props }) {
  const { locked, full, update } = props;
  // 显式 disabled 会盖过 ConfigProvider 的 componentDisabled，锁定时要并进来
  const off = (blocked: boolean) => locked || blocked;
  return (
    <Space size={0} wrap>
      <Button type="link" size="small" disabled={off(full)} onClick={() => update(insertAfter(index, false))}>
        {sm.insertRow}
      </Button>
      <Button type="link" size="small" disabled={off(full)} onClick={() => update(insertAfter(index, true))}>
        {sm.copyRow}
      </Button>
      <Button type="link" size="small" danger onClick={() => update(removeRows(new Set([row.ref])))}>
        {sm.remove}
      </Button>
      <Button type="link" size="small" disabled={off(index === 0)} onClick={() => update(move(index, -1))}>
        {sm.up}
      </Button>
      <Button type="link" size="small" disabled={off(index === last)} onClick={() => update(move(index, 1))}>
        {sm.down}
      </Button>
    </Space>
  );
}

function Cell({ column, row, index, props }: { column: DraftColumn; row: DraftRow; index: number; props: Props }) {
  const { readonly, locked, labels, update } = props;
  const value = row.cells[column.ref] ?? [];
  if (readonly) return <>{value.map((id) => labels.label(kindOf(column), id)).join('、') || '—'}</>;
  return (
    <CellPicker
      kind={kindOf(column)}
      value={value}
      max={cellMax(column)}
      labels={labels}
      disabled={locked}
      label={sm.cell(index, column.name.trim())}
      onChange={(next) =>
        update((current) => ({
          ...current,
          rows: current.rows.map((item) =>
            item.ref === row.ref ? { ...item, cells: { ...item.cells, [column.ref]: next } } : item,
          ),
        }))
      }
    />
  );
}

export function StructureRows(props: Props) {
  const { structure, invalid, readonly, locked, selected, select } = props;
  const position = new Map(structure.rows.map((row, index) => [row.ref, index]));
  const at = (row: DraftRow) => position.get(row.ref)!;
  const last = structure.rows.length - 1;
  const columns = [
    {
      title: sm.seq,
      key: 'seq',
      width: 64,
      render: (_: unknown, row: DraftRow) => <span className="matrix-seq">{at(row) + 1}</span>,
    },
    ...structure.columns.map((column, index) => ({
      title: column.name.trim() || sm.column(index),
      key: column.ref,
      className: 'matrix-cell',
      render: (_: unknown, row: DraftRow) => <Cell column={column} row={row} index={at(row)} props={props} />,
    })),
    ...(readonly
      ? []
      : [
          {
            title: sm.operations,
            key: 'operations',
            width: 220,
            render: (_: unknown, row: DraftRow) => <Operations index={at(row)} last={last} row={row} props={props} />,
          },
        ]),
  ];
  return (
    <Table
      className="matrix-rows"
      size="small"
      rowKey="ref"
      scroll={{ x: 'max-content' }}
      dataSource={structure.rows}
      columns={columns}
      locale={{ emptyText: sm.noRows }}
      pagination={{ pageSize: ROW_PAGE_SIZE, showSizeChanger: false, hideOnSinglePage: true }}
      rowClassName={(row) => (invalid.has(row.ref) ? 'matrix-invalid' : '')}
      rowSelection={
        readonly
          ? undefined
          : {
              selectedRowKeys: selected,
              onChange: (keys) => select(keys as string[]),
              getCheckboxProps: () => ({ disabled: locked }),
            }
      }
    />
  );
}
