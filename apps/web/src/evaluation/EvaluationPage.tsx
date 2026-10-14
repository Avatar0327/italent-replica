import { App, Button, Descriptions, Select, Space, Table, Tag } from 'antd';
import { useState } from 'react';
import { ListPage, DetailPage } from '../foundation/templates.js';
import { usePermissions } from '../foundation/Permissions.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { pageQuery, type PageResult } from '../foundation/client.js';
import { PageState } from '../foundation/PageState.js';
import { ActivityWizard, EVALUATION } from './ActivityWizard.js';
import { EV } from './ActivityFields.js';
import { Failure, useRead, useWriter } from './runtime.js';
import { evaluationActions, records, type Row } from './model.js';
import { m, statusText, textValue } from './messages.js';
import { evaluationDemoStages } from '../demo-stubs/evaluation.js';
import { CreateCommands, CreateEntry } from './CreateEntry.js';
import './pages.css';

export function EvaluationPage() {
  return (
    <CreateCommands>
      <EvaluationContent />
    </CreateCommands>
  );
}
function EvaluationContent() {
  const permission = usePermissions(EVALUATION);
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [status, setStatus] = useState('');
  const [selected, select] = useState<string>();
  const [create, setCreate] = useState(false);
  const query = pageQuery(page);
  if (status && permission.field('status').visible) query.set('status', status);
  const list = useRead<PageResult<Row>>(`${EV}/activities?${query}`);
  const columns = evaluationColumns(permission, select);
  return (
    <>
      <DecisionNote id="evaluation" />
      <ListPage
        title={m.title}
        data={list.data ?? { items: [] }}
        columns={[
          ...columns,
          {
            title: m.actions,
            key: 'actions',
            render: (_: unknown, row: Row) => (
              <Button type="link" onClick={() => select(row.id)}>
                {m.view}
              </Button>
            ),
          },
        ]}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        loading={list.loading}
        error={list.error}
        retry={list.reload}
        actions={
          <Space>
            <Button onClick={list.reload}>{m.refresh}</Button>
            {permission.can('create', 'list') && (
              <Button type="primary" onClick={() => setCreate(true)}>
                {m.create}
              </Button>
            )}
          </Space>
        }
        filters={
          permission.field('status').visible && (
            <Select
              aria-label={m.status}
              style={{ width: 140 }}
              value={status}
              options={['', 'draft', 'published', 'completed'].map((value) => ({
                value,
                label: value ? statusText(value) : m.all,
              }))}
              onChange={(value) => {
                setStatus(value);
                setPage({ ...page, page: 1 });
              }}
            />
          )
        }
      />
      {create && (
        <CreateEntry path={`${EV}/activities`} title={m.create} close={() => setCreate(false)}>
          <ActivityWizard close={() => setCreate(false)} saved={list.reload} />
        </CreateEntry>
      )}
      {selected && <ActivityDetail key={selected} id={selected} close={() => select(undefined)} saved={list.reload} />}
    </>
  );
}
function ActivityDetail({ id, close, saved }: { id: string; close(): void; saved(): void }) {
  const permission = usePermissions(EVALUATION);
  const detail = useRead<Row>(`${EV}/activities/${id}`);
  const [editing, edit] = useState(false);
  const { modal } = App.useApp();
  const writer = useWriter(() => {
    detail.reload();
    saved();
  });
  const row = detail.data;
  const actions = row ? evaluationActions(row) : [];
  const perform = (action: 'publish' | 'unpublish') =>
    modal.confirm({
      title: m.confirm,
      content: m.confirmBody,
      onOk: () => writer.write(`${EV}/activities/${id}/${action}`, 'POST', {}, row!.revision).catch(() => undefined),
    });

  return (
    <DetailPage
      open
      onClose={close}
      title={row?.name ?? m.title}
      actions={
        <Space>
          <Button
            onClick={() => {
              detail.reload();
              writer.reset();
            }}
          >
            {m.refresh}
          </Button>
          {row && permission.can('update') && row.status !== 'completed' && (
            <Button onClick={() => edit(true)}>{m.edit}</Button>
          )}
          {row &&
            actions
              .filter((action) => permission.can(action, 'list_row'))
              .map((action) => (
                <Button
                  key={action}
                  type="primary"
                  loading={writer.busy}
                  disabled={writer.blocked}
                  onClick={() => perform(action)}
                >
                  {m[action]}
                </Button>
              ))}
        </Space>
      }
      summary={
        <>
          <DecisionNote id="evaluation" />
          <Failure error={writer.error} retry={writer.reset} />
          <Failure error={detail.error} retry={detail.reload} />
          {detail.loading && <PageState kind="loading" />}
          {editing && row && (
            <ActivityWizard
              key={row.id}
              row={row}
              close={() => edit(false)}
              saved={() => {
                detail.reload();
                saved();
              }}
            />
          )}
        </>
      }
      tabs={evaluationTabs({ row, fields, permission, id, modal })}
    />
  );
}
function Roster({ activityId }: { activityId: string }) {
  const object = 'TEvaluation.StaffEvaluationData';
  const permission = usePermissions(object);
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const allowed = permission.snapshot.objects[object] && permission.field('activityId').visible;
  const list = useRead<PageResult<Row>>(
    allowed ? `${EV}/staff-evaluations?activityId=${activityId}&${pageQuery(page)}` : undefined,
  );
  if (!allowed) return <PageState kind="forbidden" />;
  return (
    <ListPage
      title={m.roster}
      data={list.data ?? { items: [] }}
      rowKey="id"
      page={page}
      onPageChange={setPage}
      loading={list.loading}
      error={list.error}
      retry={list.reload}
      columns={[
        'employeeId',
        'applyCategoryId',
        'applyLevelId',
        'currentStage',
        'applyStatus',
        'finalResult',
        'finalScore',
      ]
        .filter((key) => permission.field(key).visible)
        .map((key) => ({ title: m[key as 'employeeId'], dataIndex: key, render: textValue }))}
    />
  );
}

function evaluationColumns(permission: ReturnType<typeof usePermissions>, select: (id: string) => void) {
  const columns = ['name', 'year', 'cycleId', 'status', 'ownerOrgId', 'applyCount', 'manager']
    .filter((key) => permission.field(key).visible)
    .map((key) => ({
      title: m[key as 'name'],
      dataIndex: key,
      render: (value: unknown, row: Row) => {
        if (key === 'name')
          return (
            <Button type="link" onClick={() => select(row.id)}>
              {textValue(value)}
            </Button>
          );
        if (key === 'status') return <Tag color={value === 'published' ? 'blue' : 'default'}>{statusText(value)}</Tag>;
        return textValue(key === 'manager' ? (value as { name?: string })?.name : value);
      },
    }));
  return columns;
}

function evaluationTabs({
  row,
  fields,
  permission,
  id,
  modal,
}: {
  row?: Row;
  fields: string[];
  permission: ReturnType<typeof usePermissions>;
  id: string;
  modal: ReturnType<typeof App.useApp>['modal'];
}) {
  return row
    ? [
        {
          key: 'basic',
          label: m.basic,
          children: (
            <Descriptions
              column={2}
              items={fields
                .filter((key) => permission.field(key).visible)
                .map((key) => ({
                  key,
                  label: m[key as 'name'],
                  children: key === 'status' ? statusText(row[key]) : textValue(row[key]),
                }))}
            />
          ),
        },
        {
          key: 'conditions',
          label: m.conditions,
          children: permission.field('conditions').visible ? (
            <Table
              pagination={false}
              rowKey="_key"
              dataSource={records(row.conditions).map((condition, index) => ({ ...condition, _key: index }))}
              columns={[
                { title: m.conditions, dataIndex: 'kind', render: (v: string) => m[v as 'common'] ?? v },
                { title: m.applicants, dataIndex: 'applicantKind', render: (v: string) => m[v as 'self'] ?? v },
                { title: m.expression, dataIndex: 'expression', render: textValue },
              ]}
            />
          ) : null,
        },
        {
          key: 'chains',
          label: m.chains,
          children: permission.field('chains').visible ? (
            <div className="r3b-flow">
              {records(row.chains).map((chain, index) => (
                <div className="r3b-stage" key={index}>
                  <strong>{textValue(chain.name)}</strong>
                  {textValue(chain.startDate)} ～ {textValue(chain.endDate)}
                </div>
              ))}
            </div>
          ) : null,
        },
        { key: 'roster', label: m.roster, children: <Roster activityId={id} /> },
        {
          key: 'demo',
          label: m.process,
          children: (
            <>
              <PausedFlow permission={permission} modal={modal} />
            </>
          ),
        },
      ]
    : [];
}

function PausedFlow({
  permission,
  modal,
}: {
  permission: ReturnType<typeof usePermissions>;
  modal: ReturnType<typeof App.useApp>['modal'];
}) {
  return (
    <>
      <DecisionNote id="evaluation-paused" />
      <Tag color="orange">{m.demo}</Tag>
      <p>{m.demoNote}</p>
      <div className="r3b-flow">
        {evaluationDemoStages.map((stage) => (
          <div className="r3b-stage" key={stage}>
            <strong>{stage}</strong>
            {m.demo}
          </div>
        ))}
      </div>
      <p>{m.paused}</p>
      {permission.can('complete', 'list_row') && (
        <Button onClick={() => modal.info({ title: m.complete, content: m.demoComplete })}>{m.complete}</Button>
      )}
    </>
  );
}

const fields = [
  'name',
  'status',
  'year',
  'cycleId',
  'ownerOrgId',
  'startDate',
  'endDate',
  'effectiveDate',
  'applyCount',
];
