import { Alert, Button, Space, Table, Tooltip, type TableColumnsType } from 'antd';
import type { ReactNode } from 'react';
import { columns, ui, type ColumnSpec } from './alignment.js';
import { display, m } from './messages.js';
import { Failure } from '../evaluation/runtime.js';
import type { Row } from '../evaluation/model.js';

export const missing = <span title={ui.missing}>—</span>;
export function Unverified({ missingContract = false }: { missingContract?: boolean }) {
  return <Alert showIcon type="info" message={missingContract ? ui.missing : ui.unverified} />;
}
export function PendingButtons({ labels }: { labels: readonly string[] }) {
  return (
    <Space size="small">
      {labels.map((label) => (
        <Tooltip key={label} title={ui.unverified}>
          <span>
            <Button disabled size="small">
              {label}
            </Button>
          </span>
        </Tooltip>
      ))}
    </Space>
  );
}
export function Filters({ fields }: { fields: readonly string[] }) {
  return (
    <div className="survey-filters" aria-label={ui.filter}>
      {fields.map((label) => (
        <Tooltip key={label} title={ui.unverified}>
          <span>
            <Button type="text" disabled aria-label={label}>
              {label} <span aria-hidden>⌄</span>
            </Button>
          </span>
        </Tooltip>
      ))}
    </div>
  );
}
export function alignedColumns(
  kind: string,
  visible: (field: string) => boolean,
  renderers: Record<string, (value: unknown, row: Row) => ReactNode> = {},
  actions?: { title?: string; width: number; render(row: Row): ReactNode },
): TableColumnsType<Row> {
  return [
    ...columns[kind]!.filter(([, , , field]) => !field || visible(field)).map(([key, title, width, field]) => ({
      key,
      title,
      width,
      dataIndex: key,
      ellipsis: true,
      render: renderers[key] ?? ((value: unknown) => (field ? display(value) : missing)),
    })),
    ...(actions
      ? [
          {
            key: 'actions',
            title: actions.title ?? m.actions,
            width: actions.width,
            fixed: 'right' as const,
            render: (_: unknown, row: Row) => actions.render(row),
          },
        ]
      : []),
    { key: 'gear', title: <span aria-label={ui.gear}>⚙</span>, width: 26, fixed: 'right', render: () => null },
  ];
}
export function columnFilters(spec: ColumnSpec[], visible: (field: string) => boolean) {
  return spec.filter(([, , , field]) => !field || visible(field)).map(([, label]) => label);
}
export function SurveyTable(props: {
  rows: Row[];
  columns: TableColumnsType<Row>;
  loading?: boolean;
  error?: unknown;
  reload(): void;
  selection?: boolean;
  rowKey?: string;
}) {
  return (
    <>
      <Failure error={props.error} retry={props.reload} />
      {!props.error && (
        <Table<Row>
          rowKey={props.rowKey ?? 'id'}
          dataSource={props.rows}
          columns={props.columns}
          loading={props.loading}
          size="small"
          scroll={{ x: 'max-content' }}
          rowSelection={props.selection ? { columnWidth: 30 } : undefined}
          pagination={{ defaultPageSize: 15, hideOnSinglePage: true, showSizeChanger: false }}
        />
      )}
      {!props.error && !props.loading && <p className="survey-total">{ui.total(props.rows.length)}</p>}
      <p className="r3b-note">{ui.missingHint}</p>
    </>
  );
}
