// 列定义：类型、列名、维度、包含下级 / 允许多人、删除。已保存列的类型与维度只读：后端不拦截改维度，
// 但改了会让已选值失去意义，按最保守口径不给改（未决 / 假设见 PR 描述）；新列改维度时清空该列已选值。
import { Button, Checkbox, Input, Select, Table, Tag } from 'antd';
import { MATRIX_DIMENSIONS } from '@italent/domain';
import { sm } from './structure-messages.js';
import type { Dimension, DraftColumn, Structure } from './structure-model.js';

type Update = (change: (structure: Structure) => Structure) => void;
const patch =
  (ref: string, change: Partial<DraftColumn>, resetCells = false): Parameters<Update>[0] =>
  (structure) => ({
    columns: structure.columns.map((column) => (column.ref === ref ? { ...column, ...change } : column)),
    rows: resetCells ? structure.rows.map((row) => ({ ...row, cells: { ...row.cells, [ref]: [] } })) : structure.rows,
  });
const removeColumn = (ref: string) => (structure: Structure) => ({
  columns: structure.columns.filter((column) => column.ref !== ref),
  rows: structure.rows.map((row) => {
    const { [ref]: _removed, ...cells } = row.cells;
    return { ...row, cells };
  }),
});
const dimensionOptions = MATRIX_DIMENSIONS.map((value) => ({ value, label: sm.dimensionLabel[value] }));

/** 角色列可设允许多人；只有部门条件列可设包含下级。 */
function togglesOf(column: DraftColumn) {
  if (column.kind === 'role') return [{ field: 'allowMultiple' as const, label: sm.allowMultiple }];
  return column.dimension === 'department' ? [{ field: 'includeChildren' as const, label: sm.includeChildren }] : [];
}

function Options({ column, update, readonly }: { column: DraftColumn; update: Update; readonly: boolean }) {
  const toggles = togglesOf(column);
  if (readonly) return toggles.filter(({ field }) => column[field]).map(({ label }) => <Tag key={label}>{label}</Tag>);
  return toggles.map(({ field, label }) => (
    <Checkbox
      key={field}
      checked={column[field]}
      onChange={(event) => update(patch(column.ref, { [field]: event.target.checked }))}
    >
      {label}
    </Checkbox>
  ));
}

export function StructureColumns(props: {
  structure: Structure;
  invalid: ReadonlySet<string>;
  readonly: boolean;
  update: Update;
}) {
  const { structure, invalid, readonly, update } = props;
  const columns = [
    {
      title: sm.kind,
      key: 'kind',
      width: 96,
      render: (_: unknown, column: DraftColumn) => <span className="matrix-kind">{sm.kindLabel[column.kind]}</span>,
    },
    {
      title: sm.columnName,
      key: 'name',
      render: (_: unknown, column: DraftColumn) =>
        readonly ? (
          column.name
        ) : (
          <Input
            aria-label={sm.columnName}
            value={column.name}
            onChange={(event) => update(patch(column.ref, { name: event.target.value }))}
          />
        ),
    },
    {
      title: sm.dimension,
      key: 'dimension',
      width: 120,
      render: (_: unknown, column: DraftColumn) => {
        if (column.kind === 'role') return '—';
        if (readonly || column.id) return sm.dimensionLabel[column.dimension ?? ''];
        return (
          <Select
            aria-label={sm.dimension}
            value={column.dimension}
            options={dimensionOptions}
            onChange={(dimension: Dimension) =>
              update(patch(column.ref, { dimension, includeChildren: false }, dimension !== column.dimension))
            }
          />
        );
      },
    },
    {
      title: sm.options,
      key: 'options',
      render: (_: unknown, column: DraftColumn) => <Options column={column} update={update} readonly={readonly} />,
    },
    ...(readonly
      ? []
      : [
          {
            title: sm.operations,
            key: 'operations',
            width: 80,
            render: (_: unknown, column: DraftColumn) => (
              <Button type="link" size="small" danger onClick={() => update(removeColumn(column.ref))}>
                {sm.remove}
              </Button>
            ),
          },
        ]),
  ];
  return (
    <Table
      className="matrix-columns"
      size="small"
      rowKey="ref"
      pagination={false}
      dataSource={structure.columns}
      columns={columns}
      locale={{ emptyText: sm.noColumns }}
      rowClassName={(column) => (invalid.has(column.ref) ? 'matrix-invalid' : '')}
    />
  );
}
