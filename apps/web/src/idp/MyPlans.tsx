import { Button, Select, Table, Tooltip, type TableColumnsType } from 'antd';
import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { useSession } from '../foundation/Session.js';
import { ViewHeading } from '../foundation/ViewHeading.js';
import { IDP_API, useCollection } from './api.js';
import { t } from './messages.js';
import { display, matchesFilters, ownPlans, statusText, type PlanFilters } from './model.js';
import { PlanDetailPage } from './PlanDetail.js';
import type { PlanSummary } from './types.js';
import { IdpCommands } from './commands.js';
import { useNames } from './useNames.js';
import './idp.css';

const DETAIL = 'plan';

/**
 * 员工自助 > 我的发展计划 > 个人发展计划（原站 04 / B5_23）：只列本人作为被发展人的进行中、已结束计划
 * （已终止的后端不返回，F-164），表格 + 行内筛选（状态 / 指导人 / 起止时间）。HR 干预动作不在本页提供。
 */
export function MyPlansPage() {
  const session = useSession();
  return (
    <IdpCommands>
      <MyPlans key={`${session.tenantId}/${session.identityKey}`} employeeId={session.employeeId ?? undefined} />
    </IdpCommands>
  );
}

/** 我的发展计划 > 我辅导的发展计划（原站 B5_26）：本人任指导人的进行中计划（tutor-plans，F-164）。 */
export function TutorPlansPage() {
  const session = useSession();
  return (
    <IdpCommands>
      <TutorPlans key={`${session.tenantId}/${session.identityKey}`} />
    </IdpCommands>
  );
}

function MyPlans({ employeeId }: { employeeId?: string }) {
  const list = useCollection<PlanSummary>(`${IDP_API}/my-plans`);
  const [filters, setFilters] = useState<PlanFilters>({});
  const rows = useMemo(
    () => ownPlans(list.items ?? [], employeeId).filter((row) => matchesFilters(row, filters)),
    [list.items, employeeId, filters],
  );
  return (
    <PlanListPage
      title={t.personalPlans}
      note="idp-my-plans"
      others="own"
      list={list}
      rows={rows}
      filters={<InlineFilters value={filters} change={setFilters} />}
    />
  );
}

function TutorPlans() {
  const list = useCollection<PlanSummary>(`${IDP_API}/tutor-plans`);
  const [filters, setFilters] = useState<PlanFilters>({});
  const rows = useMemo(() => (list.items ?? []).filter((row) => matchesFilters(row, filters)), [list.items, filters]);
  const employees = useNames(
    'employee',
    (list.items ?? []).map((row) => row.employeeId),
  );
  const people = [...new Set((list.items ?? []).map((row) => row.employeeId).filter((id): id is string => !!id))];
  return (
    <PlanListPage
      title={t.tutorPlans}
      note="idp-tutor-plans"
      others="tutoring"
      list={list}
      rows={rows}
      filters={
        <InlineFilters
          value={filters}
          change={setFilters}
          people={people.map((id) => ({ value: id, label: employees(id) }))}
        />
      }
    />
  );
}

function PlanListPage(props: {
  title: string;
  note: string;
  others: 'own' | 'tutoring';
  list: ReturnType<typeof useCollection<PlanSummary>>;
  rows: PlanSummary[];
  filters: ReactNode;
}) {
  const { title, note, others, list, rows, filters } = props;
  const [params, setParams] = useSearchParams();
  const openId = params.get(DETAIL);
  const open = (id?: string) => setParams(id ? { [DETAIL]: id } : {});
  const names = useNames(
    'employee',
    rows.flatMap((row) => [row.employeeId, row.tutorEmployeeId]),
  );
  if (openId)
    return (
      <div className="idp-page idp-my-plans">
        <PlanDetailPage
          id={openId}
          onBack={() => open()}
          can={() => false}
          edit={() => undefined}
          intervene={() => undefined}
          others={others}
        />
      </div>
    );
  return (
    <div className="idp-page idp-my-plans">
      <header className="page-heading">
        <ViewHeading title={title} />
        <Button onClick={list.reload}>{t.actions.refresh}</Button>
      </header>
      <DecisionNote id={note} />
      {filters}
      {list.error ? (
        <PageState kind="error" error={list.error} retry={list.reload} />
      ) : (
        <Table<PlanSummary>
          size="small"
          rowKey="id"
          loading={list.loading}
          dataSource={rows}
          columns={columns(names, open)}
          locale={{ emptyText: t.empty }}
          pagination={{ pageSize: 15, showTotal: t.total, showSizeChanger: false }}
        />
      )}
    </div>
  );
}

function columns(names: (id?: string | null) => string, open: (id: string) => void): TableColumnsType<PlanSummary> {
  return [
    {
      key: 'name',
      title: t.fields.name,
      render: (_, row) => (
        <Button type="link" className="idp-link" onClick={() => open(row.id)}>
          {display(row.name)}
        </Button>
      ),
    },
    { key: 'employeeId', title: t.fields.employeeId, render: (_, row) => names(row.employeeId) },
    // 个人发展计划接口不返回指导人（plan-routes my-plans 固定字段），如实显示 --（后端缺口）；我辅导的发展计划返回本人
    {
      key: 'tutorEmployeeId',
      title: t.fields.tutorEmployeeId,
      render: (_, row) => (row.tutorEmployeeId ? names(row.tutorEmployeeId) : t.noValue),
    },
    { key: 'status', title: t.fields.status, render: (_, row) => statusText(t.status, row.status) },
    // 原站“当前步骤”列显示阶段名（如“制定计划”）；列表接口只返回当前阶段，按阶段名展示
    { key: 'currentStageName', title: t.fields.currentNodeName, render: (_, row) => display(row.currentStageName) },
  ];
}

const statusOptions = ['running', 'ended', 'terminated'].map((value) => ({ value, label: t.status[value] }));

const TARGET = 'target';
/**
 * 原站 04 的行内筛选：状态、指导人、开始时间、结束时间；指导人因接口未返回暂不可选（后端缺口）。
 * 我辅导的发展计划（B5_26）另有姓名（列表里出现的员工）与“辅导员工分类”；分类只有“辅导对象”一项，列表全是辅导对象。
 * 状态照原站保留全部选项：本页只列进行中，个人发展计划不列已终止，选了为空。
 */
function InlineFilters(props: {
  value: PlanFilters;
  change(value: PlanFilters): void;
  people?: { value: string; label: string }[];
}) {
  const { value, change, people } = props;
  return (
    <div className="idp-inline-filters">
      {people && (
        <>
          <label htmlFor="idp-my-employee">{t.fields.employeeId}</label>
          <Select
            id="idp-my-employee"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder={t.choose}
            value={value.employeeId}
            options={people}
            onChange={(employeeId) => change({ ...value, employeeId })}
          />
        </>
      )}
      <label htmlFor="idp-my-status">{t.fields.status}</label>
      <Select
        id="idp-my-status"
        allowClear
        placeholder={t.choose}
        value={value.status}
        options={statusOptions}
        onChange={(status) => change({ ...value, status })}
      />
      <label htmlFor="idp-my-tutor">{t.fields.tutorEmployeeId}</label>
      <Tooltip title={t.gaps.tutor}>
        <Select id="idp-my-tutor" disabled placeholder={t.choose} />
      </Tooltip>
      <label>{t.fields.startDate}</label>
      <TenantDatePicker
        value={value.startFrom}
        onChange={(date) => change({ ...value, startFrom: date ?? undefined })}
      />
      <label>{t.fields.endDate}</label>
      <TenantDatePicker value={value.endTo} onChange={(date) => change({ ...value, endTo: date ?? undefined })} />
      {people && (
        <>
          <label htmlFor="idp-my-category">{t.tutorCategory}</label>
          <Select id="idp-my-category" value={TARGET} options={[{ value: TARGET, label: t.tutorTarget }]} />
        </>
      )}
    </div>
  );
}
