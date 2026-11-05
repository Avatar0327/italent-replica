import { Button, Descriptions, Progress, Space, Tabs, Table } from 'antd';
import { useState, type ComponentProps } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import type { DetailPage } from '../foundation/templates.js';
import { useRead, Failure } from '../evaluation/runtime.js';
import type { Row } from '../evaluation/model.js';
import { m as common } from '../evaluation/messages.js';
import { m, display } from './messages.js';
import { ui } from './alignment.js';
import { Filters, PendingButtons, SurveyTable, alignedColumns, missing, Unverified } from './Presentation.js';
const BASE = '/api/tenant/survey360';

export function ActivityDetailLayout(props: ComponentProps<typeof DetailPage>) {
  return (
    <section className="survey-detail-page" aria-label={props.title}>
      <header>
        <h1>{props.title}</h1>
        <Space>
          <Button onClick={props.onClose}>{ui.back}</Button>
          {props.actions}
        </Space>
      </header>
      {props.summary}
      <div className="survey-card">
        <Tabs items={props.tabs} destroyOnHidden />
      </div>
    </section>
  );
}
export function ActivityBasic({ row }: { row: Row }) {
  const permission = usePermissions('Survey360.Activity');
  const grants = useRead<{ authorized: { userId: string }[]; names: Record<string, string | null> }>(
    `${BASE}/activities/${row.id}/grants`,
  );
  const fields = (keys: string[]) =>
    keys
      .filter((key) => permission.field(key).visible)
      .map((key) => ({
        key,
        label: key === 'name' ? ui.activityName : m[key as 'name'],
        span: key === 'welcome' ? 2 : 1,
        children: activityValue(key, row[key]),
      }));
  const pending = (labels: readonly string[]) => labels.map((label) => ({ key: label, label, children: missing }));
  return (
    <div className="survey-basic">
      <Descriptions column={2} items={fields(['name', 'scene'])} />
      <h2>{m.answering}</h2>
      <Descriptions
        column={2}
        items={[
          ...fields(['welcome', 'showAppraiserName', 'roleDisplay', 'form']),
          ...pending([ui.grouping, ui.order, ui.ignore]),
        ]}
      />
      <h2>{ui.reminders}</h2>
      <Descriptions column={2} items={pending([ui.during, ui.onSubmit])} />
      <h2>{ui.results}</h2>
      <Descriptions items={pending([ui.invalidCard])} />
      <Unverified missingContract />
      <h2>{ui.authorization}</h2>
      <p>{ui.authorizationHint}</p>
      <Failure error={grants.error} retry={grants.reload} />
      <Table
        rowKey="userId"
        loading={grants.loading}
        dataSource={grants.error ? [] : (grants.data?.authorized ?? [])}
        pagination={false}
        columns={[
          { title: ui.user, dataIndex: 'userId', render: (id: string) => grants.data?.names[id] ?? common.noValue },
          ...[ui.department, ui.position, ui.identity].map((title) => ({ title, key: title, render: () => missing })),
        ]}
      />
    </div>
  );
}

export function ReadingPanel({ activityId, kind }: { activityId: string; kind: 'progress' | 'data' | 'reports' }) {
  const config = panelConfig[kind];
  const object = kind === 'reports' ? 'Survey360.Result' : 'Survey360.Relation';
  const permission = usePermissions(object);
  const person = usePermissions('Survey360.Person');
  const allowed = !!permission.snapshot.objects[object];
  const list = useRead<{ items: Row[]; total?: { completed: number; all: number } }>(
    allowed ? `${BASE}/activities/${activityId}/${kind === 'data' ? 'objects' : kind}` : undefined,
  );
  const [tab, setTab] = useState('appraisers');
  const visible = (field: string) =>
    field.startsWith('person.')
      ? permission.field('person').visible && person.field(field.slice(7)).visible
      : permission.field(field).visible;
  if (!allowed) return <PageState kind="forbidden" />;
  const progress = list.data?.total;
  const rate = progress && progress.all > 0 ? Math.round((progress.completed / progress.all) * 10000) / 100 : undefined;
  const filterKeys = panelFilters(kind);
  return (
    <section className="survey-panel">
      {kind === 'progress' && (
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'appraisers', label: m.appraiser },
            { key: 'objects', label: m.person },
          ]}
        />
      )}
      {kind === 'progress' && tab === 'objects' ? (
        <Unverified />
      ) : (
        <>
          {kind === 'progress' && permission.field('progress').visible && (
            <div className="survey-progress">
              {ui.totalProgress} {rate === undefined ? common.noValue : <Progress percent={rate} size="small" />}
            </div>
          )}
          <div className="survey-toolbar">
            <Filters fields={filterKeys.filter(([, field]) => !field || visible(field)).map(([label]) => label!)} />
            <Space>
              <Button onClick={list.reload}>{common.refresh}</Button>
              <PendingButtons labels={config.tools} />
            </Space>
          </div>
          <SurveyTable
            rows={list.data?.items ?? []}
            loading={list.loading}
            error={list.error}
            reload={list.reload}
            selection={kind !== 'data'}
            rowKey={config.rowKey}
            columns={panelColumns(kind, visible)}
          />
        </>
      )}
    </section>
  );
}

const panelConfig = {
  progress: { tools: ui.progressTools, actions: ui.progressActions, rowKey: 'personId', width: 160 },
  data: { tools: ui.dataTools, actions: [ui.raw], rowKey: 'id', width: 98 },
  reports: { tools: ui.reportTools, actions: ui.reportActions, rowKey: 'objectId', width: 86 },
};
function panelFilters(kind: keyof typeof panelConfig) {
  const filters = {
    progress: [
      [ui.person, 'name'],
      [ui.email, 'email'],
      [ui.mobile],
      [ui.emailState, 'emailState'],
      [ui.smsState],
      [ui.advanced],
    ],
    data: [[ui.person, 'person.name'], [ui.email, 'person.email'], [ui.department], [ui.position]],
    reports: [
      [ui.person, 'objectName'],
      [ui.email],
      [ui.mobile],
      [ui.department, 'department'],
      [ui.reportStatus, 'status'],
      [ui.advanced],
    ],
  };
  return filters[kind];
}

function panelColumns(kind: keyof typeof panelConfig, visible: (field: string) => boolean) {
  return alignedColumns(
    kind,
    visible,
    {
      personName: (_, row) => (row.person as { name?: string })?.name ?? common.noValue,
      email: (value, row) => {
        if (kind === 'data') return (row.person as { email?: string })?.email ?? common.noValue;
        if (kind === 'reports') return missing;
        return display(value);
      },
      progress: (value) => {
        const p = value as { done?: number; total?: number } | undefined;
        return p?.done !== undefined && p.total !== undefined ? `${p.done}/${p.total}` : common.noValue;
      },
      template: (value) => (value as { name?: string })?.name ?? common.noValue,
    },
    {
      width: panelConfig[kind].width,
      render: () => <PendingButtons labels={panelConfig[kind].actions} />,
    },
  );
}

function activityValue(key: string, value: unknown) {
  if (value === undefined || value === null) return common.noValue;
  if (key === 'showAppraiserName') return value ? m.show : m.hide;
  if (key === 'roleDisplay') return { name: m.nameMode, fixed_text: m.fixedMode, hidden: m.hiddenMode }[String(value)];
  return display(value);
}
