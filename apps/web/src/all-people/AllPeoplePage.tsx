import { Button, Input, Select, Space, type TableColumnsType } from 'antd';
import { useCallback, useState, type Key } from 'react';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { usePermissions } from '../foundation/Permissions.js';
import type { PageRequest } from '../foundation/client.js';
import { useApiClient } from '../foundation/Session.js';
import { PersonSelect, type Choice } from '../foundation/selectors.js';
import { ListPage } from '../foundation/templates.js';
import { useRead } from '../personnel/useRead.js';
import {
  PAGE_SIZE,
  PERSON_OBJECT,
  RECORD_OBJECT,
  allPeoplePath,
  allowedFilters,
  cell,
  columnWidth,
  defaultFilters,
  type Allowed,
  type ColumnDef,
  type Filters,
  type Row,
} from './model.js';
import { m } from './messages.js';
import './all-people.css';

interface AllPeopleResponse {
  items: Row[];
  columns: ColumnDef[];
  total: number;
  hasDataPermission?: boolean;
}

/** 按对象字段权推出筛选能否出现：姓名 / 邮箱 / 人员状态在员工档案对象，用工形式 / 雇佣关系 / 任职类型在任职记录对象。 */
function useAllowed(): Allowed {
  const person = usePermissions(PERSON_OBJECT);
  const record = usePermissions(RECORD_OBJECT);
  return (field) =>
    field === 'name' || field === 'email' || field === 'employeeStatus'
      ? person.field(field).visible
      : record.field(field).visible;
}

export function AllPeoplePage() {
  const allowed = useAllowed();
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [page, setPage] = useState<PageRequest>({ page: 1, pageSize: PAGE_SIZE });
  const [checked, setChecked] = useState<Key[]>([]);
  const result = useRead<AllPeopleResponse>(allPeoplePath(allowedFilters(filters, allowed), page));
  const apply = (next: Filters) => {
    setFilters(next);
    setPage({ ...page, page: 1 });
    setChecked([]);
  };
  // 列由接口按字段权给出，前端不再自己猜哪些列可见
  const columns: TableColumnsType<Row> = (result.data?.columns ?? []).map((column) => ({
    key: column.key,
    title: column.label,
    width: columnWidth(column.key),
    ellipsis: true,
    render: (_: unknown, row: Row) => cell(row, column.key),
  }));
  return (
    <div className="all-people-page">
      <DecisionNote id="all-people" />
      <ListPage
        title={m.title}
        data={result.data ?? { items: [] }}
        columns={columns}
        rowKey="employeeId"
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
    </div>
  );
}

const CANDIDATE_SIZE = 20;
const statusOptions = Object.entries(m.statuses).map(([value, label]) => ({ value: Number(value), label }));
const employTypeOptions = Object.entries(m.employTypes).map(([value, label]) => ({ value, label }));

/** 文本框先留在本地，回车 / 点搜索才生效，避免每个字符都发请求；父级换 key 即清空。 */
function TextFilter(props: { label: string; hint: string; initial?: string; onSearch(value: string): void }) {
  const [value, setValue] = useState(props.initial ?? '');
  return (
    <Input.Search
      aria-label={props.label}
      placeholder={props.hint}
      value={value}
      maxLength={100}
      onChange={(event) => setValue(event.target.value)}
      onSearch={props.onSearch}
    />
  );
}

/** 不允许清空：空选择等于“不筛选”，与后端缺省（试用 + 正式）不一致，容易误读。 */
function StatusFilter(props: { value?: readonly number[]; onChange(value: number[]): void }) {
  return (
    <Select
      aria-label={m.employeeStatus}
      mode="multiple"
      allowClear={false}
      value={[...(props.value ?? [])]}
      onChange={(value: number[]) => {
        if (value.length) props.onChange(value);
      }}
      style={{ minWidth: 200 }}
      options={statusOptions}
    />
  );
}

/**
 * 员工候选走服务端搜索（可见员工可达数千人，不整表预载）：按姓名子串查本接口同一口径的前 20 条，
 * 并带上当前的人员状态 / 任职类型，所以候选 = 此刻筛选下会出现在列表里的人，数据范围与字段权由接口裁剪。
 */
function EmployeeFilter(props: { filters: Filters; allowed: Allowed; onChange(employeeId?: string): void }) {
  const api = useApiClient();
  const [choice, setChoice] = useState<Choice>();
  const { employeeStatus, serviceType } = allowedFilters(props.filters, props.allowed);
  const statuses = (employeeStatus ?? []).join(',');
  const load = useCallback(
    async (query: string, signal: AbortSignal) => {
      const path = allPeoplePath(
        { employeeStatus: statuses ? statuses.split(',').map(Number) : undefined, serviceType, name: query },
        {
          page: 1,
          pageSize: CANDIDATE_SIZE,
        },
      );
      const result = await api.request<{ items: Row[] }>(path, { signal });
      return result.items.map((row) => ({ value: row.employeeId, label: cell(row, 'employeeName') }));
    },
    [api, statuses, serviceType],
  );
  const value = props.filters.employeeId === choice?.value ? choice : undefined;
  return (
    <PersonSelect
      label={m.employee}
      load={load}
      value={value}
      onChange={(next) => {
        setChoice(next);
        props.onChange(next?.value);
      }}
    />
  );
}

function QuickFilters({ filters, allowed, apply }: { filters: Filters; allowed: Allowed; apply(next: Filters): void }) {
  const [resetKey, setResetKey] = useState(0);
  const forms = useRead<{ items: { code: string; name: string }[] }>(
    allowed('employmentForm') ? '/api/tenant/employment/employment-forms' : null,
  );
  const set = (patch: Filters) => apply({ ...filters, ...patch });
  return (
    <div className="all-people-filters">
      <Space wrap key={resetKey}>
        {allowed('name') && (
          <span className="all-people-employee">
            <EmployeeFilter filters={filters} allowed={allowed} onChange={(employeeId) => set({ employeeId })} />
          </span>
        )}
        {allowed('name') && (
          <TextFilter label={m.name} hint={m.nameHint} initial={filters.name} onSearch={(v) => set({ name: v })} />
        )}
        {allowed('employmentForm') && (
          <Select
            aria-label={m.employmentForm}
            allowClear
            showSearch
            optionFilterProp="label"
            value={filters.employmentForm}
            onChange={(value?: string) => set({ employmentForm: value })}
            style={{ minWidth: 140 }}
            options={(forms.data?.items ?? []).map((item) => ({ value: item.code, label: item.name }))}
          />
        )}
        {allowed('employType') && (
          <Select
            aria-label={m.employType}
            allowClear
            value={filters.employType}
            onChange={(value?: string) => set({ employType: value })}
            style={{ minWidth: 120 }}
            options={employTypeOptions}
          />
        )}
        {allowed('email') && (
          <TextFilter label={m.email} hint={m.emailHint} initial={filters.email} onSearch={(v) => set({ email: v })} />
        )}
        {allowed('serviceType') && (
          // 本列表只含主职，选项固定；兼职 / 借调 / 外派后补
          <Select
            aria-label={m.serviceType}
            value="primary"
            disabled
            style={{ minWidth: 100 }}
            options={[{ value: 'primary', label: m.primary }]}
          />
        )}
        {allowed('employeeStatus') && (
          <StatusFilter value={filters.employeeStatus} onChange={(value) => set({ employeeStatus: value })} />
        )}
        <Button
          type="text"
          onClick={() => {
            setResetKey((key) => key + 1);
            apply(defaultFilters);
          }}
        >
          {m.reset}
        </Button>
      </Space>
    </div>
  );
}
