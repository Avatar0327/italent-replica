import {
  Alert,
  Button,
  DatePicker,
  Descriptions,
  Input,
  Select,
  Space,
  Tag,
  Tooltip,
  type TableColumnsType,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { transferExamples, type TransferListRow } from '../demo-stubs/transfer.js';
import { DecisionNote, DetailPage, FilterDrawer, ListPage, type PageRequest } from '../foundation/index.js';
import { listText as t, text as m } from './messages.js';
import {
  clearableViews,
  columnLabels,
  filterTransfers,
  statusLabels,
  transferColumns,
  transferFilters,
  transferViews,
  type TransferColumn,
  type TransferFilterValues,
  type TransferView,
} from './page-model.js';

/** 调动列表：现有任职 API 没有跨员工调动列表，仍是合成演示数据（DEC-456）；筛选只作用于这些数据。 */
export function TransferList({ view }: { view: TransferView }) {
  const [selected, setSelected] = useState<TransferListRow>();
  const [filters, setFilters] = useState<TransferFilterValues>({});
  const [page, setPage] = useState<PageRequest>({ page: 1, pageSize: 15 });
  const all = transferExamples();
  const rows = filterTransfers(all, view, filters);
  const apply = (next: TransferFilterValues) => {
    setFilters(next);
    setPage({ ...page, page: 1 });
  };
  return (
    <>
      <div className="hr-demo-notice">
        <Tag color="gold">{m.demo}</Tag>
        <span>{m.listGap}</span>
      </div>
      <div className="r1c-list">
        <ListPage
          title={transferViews.find((item) => item.key === view)!.label}
          data={{ items: rows.slice((page.page - 1) * page.pageSize, page.page * page.pageSize), total: rows.length }}
          rowKey="id"
          page={page}
          onPageChange={setPage}
          filters={<TransferFilters view={view} rows={all} value={filters} onChange={apply} />}
          columns={columnsOf(view, setSelected)}
        />
      </div>
      {selected && <TransferExampleDetail selected={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}
const choices = (values: string[]) => [...new Set(values)].map((value) => ({ value, label: value }));
const statusChoices = Object.entries(statusLabels).map(([value, label]) => ({ value, label }));
interface FilterProps {
  view: TransferView;
  rows: TransferListRow[];
  value: TransferFilterValues;
  onChange(value: TransferFilterValues): void;
}
/** 快捷筛选按视图（已完成视图没有审批状态）；高级筛选为右侧抽屉，确定后才生效。 */
function TransferFilters(props: FilterProps) {
  const { view, value, onChange } = props;
  const [draft, setDraft] = useState<TransferFilterValues>();
  const keys = transferFilters[view];
  return (
    <Space wrap>
      <FilterControls keys={keys} rows={props.rows} value={value} onChange={onChange} />
      <Button onClick={() => setDraft(value)}>{t.advanced}</Button>
      {clearableViews.includes(view) && (
        <Button type="text" onClick={() => onChange({})}>
          {t.clear}
        </Button>
      )}
      <FilterDrawer
        open={!!draft}
        onClose={() => setDraft(undefined)}
        onClear={() => setDraft({})}
        onApply={() => {
          onChange(draft ?? {});
          setDraft(undefined);
        }}
      >
        <h3>{t.advancedGroup}</h3>
        <Space direction="vertical" className="transfer-advanced">
          <FilterControls
            keys={[...keys, 'beforeDepartment', 'beforePost']}
            rows={props.rows}
            value={draft ?? {}}
            onChange={setDraft}
          />
        </Space>
      </FilterDrawer>
    </Space>
  );
}
type ControlKey = 'person' | 'date' | 'status' | keyof typeof filterSources;
interface TransferFilterProps {
  keys: readonly ControlKey[];
  rows: TransferListRow[];
  value: TransferFilterValues;
  onChange(value: TransferFilterValues): void;
}
const filterSources = {
  department: { label: t.department, field: 'department' },
  post: { label: t.post, field: 'position' },
  beforeDepartment: { label: t.beforeDepartment, field: 'beforeDepartment' },
  beforePost: { label: t.beforePost, field: 'beforePosition' },
} as const;
function FilterControls({ keys, rows, value, onChange }: TransferFilterProps) {
  const set = (patch: TransferFilterValues) => onChange({ ...value, ...patch });
  const control = (key: ControlKey) => {
    if (key === 'person')
      return (
        <Input
          key={key}
          allowClear
          className="transfer-list-search"
          aria-label={t.person}
          placeholder={t.person}
          value={value.person}
          onChange={(event) => set({ person: event.target.value })}
        />
      );
    if (key === 'date')
      return (
        <DatePicker.RangePicker
          key={key}
          aria-label={t.date}
          placeholder={[t.from, t.to]}
          value={[value.from ? dayjs(value.from) : null, value.to ? dayjs(value.to) : null]}
          onChange={(dates) => set({ from: dates?.[0]?.format('YYYY-MM-DD'), to: dates?.[1]?.format('YYYY-MM-DD') })}
        />
      );
    if (key === 'status')
      return (
        <FilterSelect
          key={key}
          label={t.status}
          options={statusChoices}
          value={value.status}
          onChange={(status) => set({ status: status as TransferListRow['status'] })}
        />
      );
    const source = filterSources[key];
    return (
      <FilterSelect
        key={key}
        label={source.label}
        options={choices(rows.map((row) => row[source.field]))}
        value={value[key]}
        onChange={(next) => {
          const patch: TransferFilterValues = {};
          patch[key] = next;
          set(patch);
        }}
      />
    );
  };
  return <>{keys.map(control)}</>;
}
function FilterSelect(props: {
  label: string;
  options: { value: string; label: string }[];
  value?: string;
  onChange(value?: string): void;
}) {
  return (
    <Select
      allowClear
      className="transfer-filter-select"
      aria-label={props.label}
      placeholder={props.label}
      options={props.options}
      value={props.value}
      onChange={(next?: string) => props.onChange(next)}
    />
  );
}

/** 列按原站各视图；审批状态与“进行中 / 已完成”交接状态在原站是蓝色链接，这里没有可打开的对象，只保留蓝色文字。 */
function columnsOf(view: TransferView, onOpen: (row: TransferListRow) => void): TableColumnsType<TransferListRow> {
  return transferColumns[view].map((column) => ({
    key: column,
    title: columnLabels[column],
    fixed: fixedOf(column),
    render: (_: unknown, row: TransferListRow) => cell(column, row, onOpen),
  }));
}
const fixedOf = (column: TransferColumn) => {
  if (column === 'name') return 'left' as const;
  return column === 'operation' ? ('right' as const) : undefined;
};
function cell(column: TransferColumn, row: TransferListRow, onOpen: (row: TransferListRow) => void) {
  if (column === 'name')
    return (
      <Button type="link" className="transfer-name-link" onClick={() => onOpen(row)}>
        {row.name}
      </Button>
    );
  if (column === 'status') return <span className="transfer-link-text">{statusLabels[row.status]}</span>;
  if (column === 'handover')
    return <span className={row.handover === t.handoverIdle ? undefined : 'transfer-link-text'}>{row.handover}</span>;
  if (column === 'operation')
    return (
      <Tooltip title={t.pendingTool}>
        <Button type="link" disabled>
          {t.process}
        </Button>
      </Tooltip>
    );
  return row[column];
}
function TransferExampleDetail({ selected, onClose }: { selected: TransferListRow; onClose(): void }) {
  return (
    <DetailPage
      open
      onClose={onClose}
      title={selected.name}
      summary={
        <>
          <DecisionNote id="transfer" />
          <Alert type="info" message={m.demo} description={m.listGap} showIcon />
          <Space>
            <Tag>{statusLabels[selected.status]}</Tag>
            {selected.code}
          </Space>
        </>
      }
      sections={[
        {
          key: 'transfer',
          title: m.adjustment,
          children: (
            <Descriptions
              bordered
              column={2}
              items={(
                ['effectiveDate', 'type', 'beforeDepartment', 'department', 'beforePosition', 'position'] as const
              ).map((key) => ({ key, label: columnLabels[key], children: selected[key] }))}
            />
          ),
        },
      ]}
    />
  );
}
