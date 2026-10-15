import { Button, Select, Table, Tooltip, type TableColumnsType } from 'antd';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CreateCommands } from '../evaluation/CreateEntry.js';
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
import { useNames } from './useNames.js';
import './idp.css';

const DETAIL = 'plan';

/**
 * 员工自助 > 我的发展计划（原站 04）：只列本人作为被发展人的计划，表格 + 行内筛选（状态 / 指导人 / 起止时间）。
 * 作为指导人或审批人参与的计划从待办与审批中心进入，不在本页列出。HR 干预动作不在本页提供。
 */
export function MyPlansPage() {
  const session = useSession();
  return (
    <CreateCommands>
      <MyPlans key={`${session.tenantId}/${session.identityKey}`} employeeId={session.employeeId ?? undefined} />
    </CreateCommands>
  );
}

function MyPlans({ employeeId }: { employeeId?: string }) {
  const list = useCollection<PlanSummary>(`${IDP_API}/my-plans`);
  const [filters, setFilters] = useState<PlanFilters>({});
  const [params, setParams] = useSearchParams();
  const openId = params.get(DETAIL);
  const open = (id?: string) => setParams(id ? { [DETAIL]: id } : {});
  const rows = useMemo(
    () => ownPlans(list.items ?? [], employeeId).filter((row) => matchesFilters(row, filters)),
    [list.items, employeeId, filters],
  );
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
        />
      </div>
    );
  return (
    <div className="idp-page idp-my-plans">
      <header className="page-heading">
        <ViewHeading title={t.myPlans} />
        <Button onClick={list.reload}>{t.actions.refresh}</Button>
      </header>
      <DecisionNote id="idp-my-plans" />
      <InlineFilters value={filters} change={setFilters} />
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
    // 参与人列表接口不返回指导人（plan-routes my-plans 固定字段），如实显示 --（后端缺口）
    {
      key: 'tutorEmployeeId',
      title: t.fields.tutorEmployeeId,
      render: (_, row) => (row.tutorEmployeeId ? names(row.tutorEmployeeId) : t.noValue),
    },
    { key: 'status', title: t.fields.status, render: (_, row) => statusText(t.status, row.status) },
    // 列表接口不返回当前步骤（后端缺口），有值才展示
    { key: 'currentNodeName', title: t.fields.currentNodeName, render: (_, row) => display(row.currentNodeName) },
  ];
}

const statusOptions = ['running', 'ended', 'terminated'].map((value) => ({ value, label: t.status[value] }));

/** 原站 04 的行内筛选：状态、指导人、开始时间、结束时间；指导人因接口未返回暂不可选（后端缺口）。 */
function InlineFilters({ value, change }: { value: PlanFilters; change(value: PlanFilters): void }) {
  return (
    <div className="idp-inline-filters">
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
    </div>
  );
}
