import { Alert, Button, Empty, Input, Select, Space, type TableColumnsType } from 'antd';
import { useState } from 'react';
import { PERSONNEL_OBJECT } from '@italent/domain';
import { ListPage } from '../foundation/templates.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { usePermissions } from '../foundation/Permissions.js';
import type { PageRequest, PageResult } from '../foundation/client.js';
import { StaffDetail } from './StaffDetail.js';
import { EditPersonButton } from './EditCommands.js';
import { personEditable } from './edit-model.js';
import { StaffFilters } from './StaffFilters.js';
import { ColumnGear, ColumnSettings } from './ColumnSettings.js';
import { useRead } from './useRead.js';
import {
  columnChoices,
  defaultColumns,
  employeeQuery,
  fieldValue,
  visibleColumns,
  columnLabel,
  type Filters,
  type Row,
} from './model.js';
import { m } from './messages.js';
import './personnel.css';

export function StaffPage() {
  const permission = usePermissions(PERSONNEL_OBJECT);
  const allowed = permission.snapshot.objects[PERSONNEL_OBJECT]?.viewableFields ?? [];
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<PageRequest>({ page: 1, pageSize: 15 });
  const [selectedColumns, setColumns] = useState(defaultColumns);
  const [overlay, setOverlay] = useState<'filter' | 'columns'>();
  const [employeeId, setEmployeeId] = useState<string>();
  const query = employeeQuery(filters, page, allowed);
  const result = useRead<PageResult<Row>>(`/api/tenant/personnel/employees?${query}`);
  const apply = (value: Filters) => {
    setFilters(value);
    setSearch(value.name ?? '');
    setPage({ ...page, page: 1 });
  };
  const columns = staffColumns(selectedColumns, allowed, setEmployeeId);
  // 原站列表行「编辑人员」（F-329）；无编辑权时整列不出现。▾ 更多菜单不在本任务范围。
  if (personEditable(permission.snapshot.objects[PERSONNEL_OBJECT]).length)
    columns.push({
      key: 'edit',
      title: m.editing.operations,
      width: 110,
      render: (_: unknown, row: Row) => <EditPersonButton employeeId={row.id} saved={result.refresh} />,
    });
  // 原站列设置入口在表头最右侧齿轮，不占工具栏按钮位。
  columns.push({ key: 'settings', width: 48, title: <ColumnGear onOpen={() => setOverlay('columns')} /> });
  return (
    <div className="staff-page">
      <DecisionNote id="personnel" />
      <DecisionNote id="personnel-records" />
      <ListPage
        title={m.title}
        data={result.data ?? { items: [] }}
        columns={columns}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        loading={result.loading}
        error={result.error}
        retry={result.refresh}
        filters={
          <QuickFilters
            allowed={allowed}
            filters={filters}
            search={search}
            setSearch={setSearch}
            apply={apply}
            open={() => setOverlay('filter')}
          />
        }
      />
      {!columnChoices.some((key) => allowed.includes(key)) && !result.loading && !result.error && (
        <Empty description={m.noFields} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
      {overlay === 'filter' && (
        <StaffFilters value={filters} allowed={allowed} onApply={apply} onClose={() => setOverlay(undefined)} />
      )}
      {overlay === 'columns' && (
        <ColumnSettings
          value={selectedColumns}
          allowed={allowed}
          onApply={setColumns}
          onClose={() => setOverlay(undefined)}
        />
      )}
      {employeeId && (
        <StaffDetail
          key={employeeId}
          employeeId={employeeId}
          onClose={() => setEmployeeId(undefined)}
          onSaved={result.refresh}
        />
      )}
    </div>
  );
}

function staffColumns(selectedColumns: string[], allowed: readonly string[], setEmployeeId: (id: string) => void) {
  const columns: TableColumnsType<Row> = visibleColumns(selectedColumns, allowed).map((key) => ({
    key,
    title: columnLabel(key),
    dataIndex: key,
    width: key === 'name' ? 150 : 155,
    ellipsis: true,
    render: (value: unknown, row: Row) =>
      key === 'name' ? (
        <Button type="link" className="staff-name" onClick={() => setEmployeeId(row.id)}>
          {fieldValue(key, value)}
        </Button>
      ) : (
        fieldValue(key, value)
      ),
  }));
  // 姓名被隐藏时仍可按服务端返回的记录 ID 进入详情；不能猜测或补齐姓名。
  if (!allowed.includes('name'))
    columns.unshift({
      key: 'open',
      title: m.detail,
      width: 150,
      render: (_: unknown, row: Row) => (
        <Button type="link" onClick={() => setEmployeeId(row.id)}>
          {m.unknownEmployee}
        </Button>
      ),
    });
  return columns;
}

function QuickFilters({
  allowed,
  filters,
  search,
  setSearch,
  apply,
  open,
}: {
  allowed: readonly string[];
  filters: Filters;
  search: string;
  setSearch(value: string): void;
  apply(value: Filters): void;
  open(): void;
}) {
  return (
    <div className="staff-filter-bar">
      <Alert className="staff-help" type="info" showIcon closable message={m.help} />
      <Space wrap>
        {allowed.includes('name') && (
          <Input.Search
            aria-label={m.search}
            placeholder={m.searchHint}
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
            onSearch={(name) => apply({ ...filters, name })}
          />
        )}
        {allowed.includes('employeeStatus') && (
          <Select
            aria-label={m.labels.employeeStatus}
            placeholder={m.labels.employeeStatus}
            allowClear
            value={filters.employeeStatus || undefined}
            onChange={(value: string | undefined) => apply({ ...filters, employeeStatus: value })}
            options={Object.entries(m.statuses).map(([value, label]) => ({ value, label }))}
          />
        )}
        <Button type="link" onClick={open}>
          {m.filter}
        </Button>
        <Button type="text" onClick={() => apply({})}>
          {m.reset}
        </Button>
      </Space>
    </div>
  );
}
