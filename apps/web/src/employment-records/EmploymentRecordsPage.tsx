import { Button, Checkbox, Input, Select, Space, type TableColumnsType } from 'antd';
import { useState, type Key } from 'react';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { usePermissions } from '../foundation/Permissions.js';
import type { PageRequest, PageResult } from '../foundation/client.js';
import { ListPage } from '../foundation/templates.js';
import { RefSelect } from '../contracts/references.js';
import { refPaths } from '../part-time/references.js';
import { StaffDetail } from '../personnel/StaffDetail.js';
import { useRead } from '../personnel/useRead.js';
import {
  EMPLOYEE_OBJECT,
  PAGE_SIZE,
  PERSON_OBJECT,
  RECORD_OBJECT,
  allowedFilters,
  cell,
  defaultFilters,
  recordsPath,
  visibleColumns,
  type Allowed,
  type Filters,
  type Row,
} from './model.js';
import { m } from './messages.js';
import './employment-records.css';

/** 按对象字段权推出筛选 / 列能否出现：姓名、工号、状态在员工对象，邮箱在人员信息对象，部门在任职记录对象。 */
function useAllowed(): { allowed: Allowed; department: boolean } {
  const employee = usePermissions(EMPLOYEE_OBJECT);
  const person = usePermissions(PERSON_OBJECT);
  const record = usePermissions(RECORD_OBJECT);
  const department = record.field('departmentId').visible;
  return {
    department,
    allowed: (field) =>
      field === 'email'
        ? person.field('email').visible
        : field === 'departmentId'
          ? department
          : field === 'isCurrent' || field === 'serviceType'
            ? record.field(field).visible
            : employee.field(field).visible,
  };
}

export function EmploymentRecordsPage() {
  const { allowed, department } = useAllowed();
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [page, setPage] = useState<PageRequest>({ page: 1, pageSize: PAGE_SIZE });
  const [checked, setChecked] = useState<Key[]>([]);
  const [employeeId, setEmployeeId] = useState<string>();
  const projected = allowedFilters(filters, allowed);
  const result = useRead<PageResult<Row>>(recordsPath(projected, page));
  const rows = result.data?.items ?? [];
  const apply = (next: Filters) => {
    setFilters(next);
    setPage({ ...page, page: 1 });
    setChecked([]);
  };
  const tableColumns: TableColumnsType<Row> = [
    ...visibleColumns(rows, allowed, department).map((column) => ({
      key: column.key,
      title: m.columns[column.key],
      width: column.width,
      ellipsis: true,
      render: (_: unknown, row: Row) => cell(row, column.key),
    })),
    {
      key: 'operation',
      title: m.columns.operation,
      width: 164,
      render: (_: unknown, row: Row) => (
        // 原站“编辑任职”落在档案的任职记录页签；写入口沿用档案内既有的编辑任职，列表不另建写入口
        <Button type="link" onClick={() => setEmployeeId(row.employeeId)}>
          {m.editRecord}
        </Button>
      ),
    },
  ];
  return (
    <div className="employment-records-page">
      <DecisionNote id="employment-records" />
      <ListPage
        title={m.title}
        data={result.data ?? { items: [] }}
        columns={tableColumns}
        rowKey="id"
        page={page}
        onPageChange={(next) => {
          setPage(next);
          setChecked([]);
        }}
        loading={result.loading}
        error={result.error}
        retry={result.refresh}
        selection={{ keys: checked, onChange: setChecked, actions: null }}
        filters={<QuickFilters filters={filters} allowed={allowed} apply={apply} />}
      />
      {employeeId && (
        <StaffDetail
          key={employeeId}
          employeeId={employeeId}
          initialTab="records"
          onClose={() => setEmployeeId(undefined)}
          onSaved={result.refresh}
        />
      )}
    </div>
  );
}

const yesNo = [
  { value: 'yes', label: m.yes },
  { value: 'no', label: m.no },
  { value: 'all', label: m.all },
];
function QuickFilters({ filters, allowed, apply }: { filters: Filters; allowed: Allowed; apply(next: Filters): void }) {
  // 文本框先留在本地，回车 / 点搜索才生效，避免每个字符都发请求
  const [name, setName] = useState(filters.name ?? '');
  const [email, setEmail] = useState(filters.email ?? '');
  const set = (patch: Filters) => apply({ ...filters, ...patch });
  return (
    <div className="employment-records-filters">
      <Space wrap>
        {allowed('name') && (
          <Input.Search
            aria-label={m.search}
            placeholder={m.searchHint}
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            onSearch={(value) => set({ name: value })}
          />
        )}
        {allowed('email') && (
          <Input.Search
            aria-label={m.email}
            placeholder={m.emailHint}
            value={email}
            maxLength={100}
            onChange={(event) => setEmail(event.target.value)}
            onSearch={(value) => set({ email: value })}
          />
        )}
        {allowed('employeeStatus') && (
          <Select
            aria-label={m.employeeStatus}
            value={filters.employeeStatus ?? 'all'}
            onChange={(value: string) => set({ employeeStatus: value })}
            style={{ minWidth: 120 }}
            options={[
              { value: 'working', label: m.working },
              ...Object.entries(m.statuses).map(([value, label]) => ({ value, label })),
              { value: 'all', label: m.all },
            ]}
          />
        )}
        {allowed('serviceType') && (
          <Select
            aria-label={m.serviceType}
            value="primary"
            disabled
            style={{ minWidth: 100 }}
            options={[{ value: 'primary', label: m.primary }]}
          />
        )}
        {allowed('departmentId') && <DepartmentFilter filters={filters} set={set} />}
        <Select
          aria-label={m.approvalState}
          value={filters.approvalState ?? 'effective'}
          onChange={(value: string) => set({ approvalState: value })}
          style={{ minWidth: 100 }}
          options={[{ value: 'effective', label: m.effective }]}
        />
        {allowed('isCurrent') && (
          <Select
            aria-label={m.current}
            value={filters.current ?? 'all'}
            onChange={(value: string) => set({ current: value })}
            style={{ minWidth: 100 }}
            options={yesNo}
          />
        )}
        <Button
          type="text"
          onClick={() => {
            setName('');
            setEmail('');
            apply(defaultFilters);
          }}
        >
          {m.reset}
        </Button>
      </Space>
    </div>
  );
}

function DepartmentFilter({ filters, set }: { filters: Filters; set(patch: Filters): void }) {
  return (
    <>
      <span className="employment-records-department">
        <RefSelect
          path={refPaths.departmentId!}
          ariaLabel={m.department}
          value={filters.departmentId}
          onChange={(next) => set({ departmentId: typeof next === 'string' ? next : undefined })}
        />
      </span>
      <Checkbox
        disabled={!filters.departmentId}
        checked={filters.includeChildren !== false}
        onChange={(event) => set({ includeChildren: event.target.checked })}
      >
        {m.includeChildren}
      </Checkbox>
    </>
  );
}
