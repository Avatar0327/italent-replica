import { CreateCommands, CreateEntry } from '../evaluation/CreateEntry.js';
import type { ReactNode } from 'react';
import { App, Button, Descriptions, Input, Select, Space, Tabs } from 'antd';
import { useState } from 'react';
import { ListPage, DetailPage } from '../foundation/templates.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import type { PageResult } from '../foundation/client.js';
import { Failure, useRead, useWriter } from '../evaluation/runtime.js';
import { useRecordForm } from '../evaluation/useRecordForm.js';
import { type Row } from '../evaluation/model.js';
import { textValue, m as common } from '../evaluation/messages.js';
import { m, display } from './messages.js';
import { surveyPath, type SurveyKind } from './model.js';
import { QuestionnaireEditor, QuestionnairePreview } from './Questionnaire.js';
import { Relations } from './Relations.js';
import '../evaluation/pages.css';

export const BASE = '/api/tenant/survey360';
export const ACTIVITY = 'Survey360.Activity';
export const QUESTIONNAIRE = 'Survey360.Questionnaire';
type Kind = SurveyKind;
const titles = { activities: m.title, questionnaires: m.questionnaires, templates: m.templates };
const createTitles = { activities: m.create, questionnaires: m.createQuestionnaire, templates: m.createTemplate };
export function SurveyPage() {
  return (
    <CreateCommands>
      <SurveyContent />
    </CreateCommands>
  );
}
function SurveyContent() {
  const activity = usePermissions(ACTIVITY);
  const questionnaire = usePermissions(QUESTIONNAIRE);
  const available = (['activities', 'questionnaires', 'templates'] as Kind[]).filter(
    (key) =>
      (key === 'activities' ? activity : questionnaire).snapshot.objects[
        key === 'activities' ? ACTIVITY : QUESTIONNAIRE
      ],
  );
  const [tab, setTab] = useState<Kind>('activities');
  const active = available.includes(tab) ? tab : available[0];
  return (
    <>
      <DecisionNote id="survey360" />
      <Tabs
        className="r3b-tabs"
        activeKey={active}
        onChange={(key) => setTab(key as Kind)}
        items={available.map((key) => ({ key, label: titles[key] }))}
      />
      {active && <SurveyList key={active} kind={active} />}
    </>
  );
}
export function SurveyList({ kind }: { kind: Kind }) {
  const object = kind === 'activities' ? ACTIVITY : QUESTIONNAIRE;
  const permission = usePermissions(object);
  const list = useRead<PageResult<Row>>(`${BASE}${surveyPath(kind)}`);
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [status, setStatus] = useState('');
  const [selected, select] = useState<string>();
  const [creating, create] = useState(false);
  const items = (list.data?.items ?? []).filter((row) => !status || row.status === status);
  const states = kind === 'activities' ? ['', 'draft', 'enabled', 'disabled'] : ['', 'draft', 'enabled', 'used'];
  const keys =
    kind === 'activities' ? ['name', 'scene', 'form', 'status', 'startedAt', 'endedAt'] : ['name', 'type', 'status'];
  return (
    <>
      <ListPage
        title={titles[kind]}
        data={{ items: items.slice((page.page - 1) * page.pageSize, page.page * page.pageSize), total: items.length }}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        loading={list.loading}
        error={list.error}
        retry={list.reload}
        columns={[
          ...keys
            .filter((key) => permission.field(key).visible)
            .map((key) => ({
              title: m[key as 'name'],
              dataIndex: key,
              render: (value: unknown, row: Row) =>
                key === 'name' ? (
                  <Button type="link" onClick={() => select(row.id)}>
                    {textValue(value)}
                  </Button>
                ) : (
                  display(value)
                ),
            })),
          {
            title: m.actions,
            key: 'actions',
            render: (_: unknown, row: Row) => (
              <Button type="link" onClick={() => select(row.id)}>
                {common.view}
              </Button>
            ),
          },
        ]}
        filters={
          permission.field('status').visible && (
            <Tabs
              activeKey={status}
              onChange={(value) => {
                setStatus(value);
                setPage({ ...page, page: 1 });
              }}
              items={states.map((key) => ({ key, label: key ? display(key) : m.all }))}
            />
          )
        }
        actions={
          <Space>
            <Button onClick={list.reload}>{common.refresh}</Button>
            {permission.can('create', 'list') && (
              <Button type="primary" onClick={() => create(true)}>
                {createTitles[kind]}
              </Button>
            )}
          </Space>
        }
      />
      <p className="r3b-note">{m.listLimit}</p>
      {creating && <Editor kind={kind} close={() => create(false)} saved={list.reload} />}
      {selected && (
        <SurveyDetail key={selected} id={selected} kind={kind} close={() => select(undefined)} saved={list.reload} />
      )}
    </>
  );
}
function SurveyDetail({ id, kind, close, saved }: { id: string; kind: Kind; close(): void; saved(): void }) {
  const permission = usePermissions(kind === 'activities' ? ACTIVITY : QUESTIONNAIRE);
  const detail = useRead<Row>(`${BASE}${surveyPath(kind)}/${id}`);
  const [editing, edit] = useState(false);
  const writer = useWriter(() => {
    detail.reload();
    saved();
  });
  const { modal } = App.useApp();
  const row = detail.data;
  const action = row?.status === 'enabled' && kind === 'activities' ? 'disable' : 'enable';
  const canChange =
    row &&
    (kind === 'activities'
      ? ['draft', 'enabled', 'disabled'].includes(row.status ?? '')
      : kind === 'questionnaires' && row.status === 'draft');
  const fields =
    kind === 'activities'
      ? ['name', 'scene', 'form', 'welcome', 'showAppraiserName', 'roleDisplay']
      : ['name', 'type', 'scoreMethod', 'guide'];
  const basic = basicInfo(fields, permission, row);
  return (
    <DetailPage
      open
      onClose={close}
      title={row?.name ?? titles[kind]}
      actions={
        <Space>
          <Button onClick={writer.reset}>{common.refresh}</Button>
          {row && permission.can('update') && <Button onClick={() => edit(true)}>{m.edit}</Button>}
          {canChange && permission.can(action) && (
            <Button
              type="primary"
              loading={writer.busy}
              disabled={writer.blocked}
              onClick={() =>
                modal.confirm({
                  title: m.confirm,
                  content: m.confirmBody,
                  onOk: () =>
                    writer.write(`${BASE}${surveyPath(kind)}/${id}/${action}`, 'POST', {}, row.revision).catch(() => undefined),
                })
              }
            >
              {m[action]}
            </Button>
          )}
        </Space>
      }
      summary={
        <>
          <DecisionNote id="survey360" />
          <Failure error={writer.error} retry={writer.reset} />
          <Failure error={detail.error} retry={detail.reload} />
          {detail.loading && <PageState kind="loading" />}
          {editing && row && (
            <Editor
              key={id}
              kind={kind}
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
      tabs={surveyTabs(row, kind, basic, id)}
    />
  );
}
function Editor({ kind, row, close, saved }: { kind: Kind; row?: Row; close(): void; saved(): void }) {
  const form =
    kind === 'activities' ? (
      <ActivityEditor row={row} close={close} saved={saved} />
    ) : (
      <QuestionnaireEditor path={`${BASE}${surveyPath(kind)}`} title={createTitles[kind]} row={row} close={close} saved={saved} />
    );
  return row ? (
    form
  ) : (
    <CreateEntry path={`${BASE}${surveyPath(kind)}`} title={createTitles[kind]} close={close}>
      {form}
    </CreateEntry>
  );
}
function ActivityEditor({ row, close, saved }: { row?: Row; close(): void; saved(): void }) {
  const permission = usePermissions(ACTIVITY);
  const writer = useRecordForm(`${BASE}/activities`, row, activityValues);
  const current = writer.current;
  const select = (keys: string[]) => <Select options={keys.map((value) => ({ value, label: display(value) }))} />;
  const controls = {
    name: <Input maxLength={200} />,
    scene: <Input maxLength={100} />,
    form: select(['single', 'multiple']),
    welcome: <Input.TextArea rows={4} maxLength={5000} />,
    showAppraiserName: (
      <Select
        options={[
          { value: 'true', label: m.show },
          { value: 'false', label: m.hide },
        ]}
      />
    ),
    roleDisplay: (
      <Select
        options={[
          { value: 'name', label: m.nameMode },
          { value: 'fixed_text', label: m.fixedMode },
          { value: 'hidden', label: m.hiddenMode },
        ]}
      />
    ),
  };
  const fields = Object.entries(controls).map(([name, control]): FormField => ({
    name,
    label: m[name as 'name'],
    control,
    access: {
      ...permission.field(name),
      editable: permission.field(name).editable && !(name === 'form' && !!current && current.status !== 'draft'),
    },
    rules: ['name', 'form'].includes(name) ? [{ required: true, message: common.required }] : [],
  }));
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={row?.id ?? 'new'}
      submission={writer}
      title={row ? m.edit : m.create}
      initialValues={
        row
          ? {
              ...row,
              showAppraiserName: row.showAppraiserName === undefined ? undefined : String(row.showAppraiserName),
            }
          : { form: 'single', showAppraiserName: 'true', roleDisplay: 'name' }
      }
      groups={[
        { title: m.basic, fields: fields.slice(0, 3) },
        { title: m.answering, fields: fields.slice(3) },
      ]}
      onClose={close}
      onSubmit={async (values) => {
        await writer.save(
          values,
          fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name),
          row ? 'PUT' : 'POST',
          (body) => ({
            ...body,
            ...('showAppraiserName' in body ? { showAppraiserName: body.showAppraiserName === 'true' } : {}),
          }),
        );
        writer.clear();
        saved();
        close();
      }}
    />
  );
}

function surveyTabs(row: Row | undefined, kind: Kind, basic: ReactNode, id: string) {
  if (!row) return [];
  if (kind === 'activities')
    return [
      { key: 'basic', label: m.basic, children: basic },
      { key: 'relations', label: m.relations, children: <Relations activityId={id} /> },
      {
        key: 'questionnaires',
        label: m.questionnaires,
        children: (
          <>
            <p className="r3b-note">{m.questionnaireLibrary}</p>
            <SurveyList kind="questionnaires" />
          </>
        ),
      },
    ];
  return [
    { key: 'basic', label: m.basic, children: basic },
    { key: 'preview', label: m.preview, children: <QuestionnairePreview row={row} /> },
  ];
}

function basicInfo(fields: string[], permission: ReturnType<typeof usePermissions>, row?: Row) {
  const basic = (
    <Descriptions
      column={2}
      items={fields
        .filter((key) => permission.field(key).visible)
        .map((key) => ({
          key,
          label: m[key as 'name'],
          children: basicValue(key, row?.[key]),
        }))}
    />
  );
  return basic;
}

function basicValue(key: string, value: unknown) {
  if (value === undefined || value === null) return common.noValue;
  if (key === 'showAppraiserName') return value ? m.show : m.hide;
  if (key === 'roleDisplay')
    return { name: m.nameMode, fixed_text: m.fixedMode, hidden: m.hiddenMode }[String(value)] ?? common.noValue;
  return display(value);
}

function activityValues(row: Row) {
  return { ...row, showAppraiserName: row.showAppraiserName === undefined ? undefined : String(row.showAppraiserName) };
}
