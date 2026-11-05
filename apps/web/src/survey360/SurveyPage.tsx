import { CreateCommands, CreateEntry } from '../evaluation/CreateEntry.js';
import type { ReactNode } from 'react';
import { Button, Descriptions, Input, Select, Space, Tabs, Tag, Table } from 'antd';
import { useState } from 'react';
import { ListPage, DetailPage } from '../foundation/templates.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import type { PageResult } from '../foundation/client.js';
import { Failure, useRead } from '../evaluation/runtime.js';
import { useSurveyForm } from './useSurveyForm.js';
import { type Row } from '../evaluation/model.js';
import { textValue, m as common } from '../evaluation/messages.js';
import { m, display } from './messages.js';
import { surveyPath, type SurveyKind } from './model.js';
import { QuestionnaireEditor, QuestionnairePreview } from './Questionnaire.js';
import { Relations } from './Relations.js';
import { StateAction } from './StateAction.js';
import { RoleSettings } from './RoleSettings.js';
import { ActivityBasic, ActivityDetailLayout, ReadingPanel } from './ReadingPanels.js';
import { alignedColumns, columnFilters, Filters, PendingButtons, missing, Unverified } from './Presentation.js';
import { columns, ui } from './alignment.js';
import './pages.css';
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
  const settings = usePermissions('Survey360.Settings');
  const [tab, setTab] = useState<Kind | 'roles'>('activities');
  const tabs = [
    ...available.map((key) => ({ key, label: titles[key] })),
    ...(settings.snapshot.objects['Survey360.Settings'] ? [{ key: 'roles', label: ui.roleSettings }] : []),
  ];
  const active = tabs.some((item) => item.key === tab) ? tab : tabs[0]?.key;
  let content = active ? <SurveyList key={active} kind={active as Kind} /> : null;
  if (active === 'roles') content = <RoleSettings />;
  if (active === 'templates') content = <TemplateLibrary />;
  return (
    <>
      <DecisionNote id="survey360" />
      <Tabs className="r3b-tabs" activeKey={active} onChange={(key) => setTab(key as Kind | 'roles')} items={tabs} />
      {content}
    </>
  );
}
export function SurveyList({ kind, activityId }: { kind: Kind; activityId?: string }) {
  const object = kind === 'activities' ? ACTIVITY : QUESTIONNAIRE;
  const permission = usePermissions(object);
  const list = useRead<PageResult<Row>>(`${BASE}${surveyPath(kind)}`);
  const relation = usePermissions('Survey360.Relation');
  const canAssociate = !!relation.snapshot.objects['Survey360.Relation'] && relation.field('questionnaireIds').visible;
  const links = useRead<{ items: Row[] }>(
    activityId && canAssociate ? `${BASE}/activities/${activityId}/objects` : undefined,
  );
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [status, setStatus] = useState('');
  const [selected, select] = useState<string>();
  const [creating, create] = useState(false);
  const associated = new Set(links.data?.items.flatMap((row) => (row.questionnaireIds as string[]) ?? []) ?? []);
  const incomplete =
    !!activityId && (!canAssociate || links.data?.items.some((row) => !Array.isArray(row.questionnaireIds)));
  const items = (list.data?.items ?? []).filter(
    (row) =>
      (!status || !permission.field('status').visible || row.status === status) &&
      (!activityId || (!incomplete && associated.has(row.id))),
  );
  const visible = (field: string) => permission.field(field).visible;
  const reload = () => {
    list.reload();
    links.reload();
  };
  if (selected && kind === 'activities')
    return <SurveyDetail key={selected} id={selected} kind={kind} close={() => select(undefined)} saved={reload} />;
  return (
    <div className="survey-page">
      <ListPage
        title={titles[kind]}
        data={{ items: items.slice((page.page - 1) * page.pageSize, page.page * page.pageSize), total: items.length }}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        loading={list.loading || links.loading}
        error={list.error ?? links.error ?? (incomplete ? new Error(ui.incompleteRelations) : undefined)}
        retry={reload}
        columns={listColumns(kind, visible, select, reload)}
        filters={
          <SurveyFilters
            kind={kind}
            visible={visible}
            status={status}
            onChange={(value) => {
              setStatus(value);
              setPage({ ...page, page: 1 });
            }}
          />
        }
        actions={
          <Space>
            <Button onClick={reload}>{common.refresh}</Button>
            {permission.can('create', 'list') && (
              <Button type="primary" onClick={() => create(true)}>
                {createTitles[kind]}
              </Button>
            )}
          </Space>
        }
      />
      <p className="r3b-note">
        {m.listLimit} {ui.missingHint}
      </p>
      {activityId && <p className="r3b-note">{ui.associated}</p>}
      {kind === 'templates' && <PendingButtons labels={[ui.enterBuiltin, ui.enterEnterprise]} />}
      <Unverified />
      {creating && <Editor kind={kind} close={() => create(false)} saved={list.reload} />}
      {selected && kind !== 'activities' && (
        <SurveyDetail key={selected} id={selected} kind={kind} close={() => select(undefined)} saved={list.reload} />
      )}
    </div>
  );
}
function SurveyDetail({ id, kind, close, saved }: { id: string; kind: Kind; close(): void; saved(): void }) {
  const permission = usePermissions(kind === 'activities' ? ACTIVITY : QUESTIONNAIRE);
  const detail = useRead<Row>(`${BASE}${surveyPath(kind)}/${id}`);
  const [editing, edit] = useState(false);
  const reload = () => {
    detail.reload();
    saved();
  };
  const row = detail.data;
  const fields =
    kind === 'activities'
      ? ['name', 'scene', 'form', 'welcome', 'showAppraiserName', 'roleDisplay']
      : ['name', 'type', 'scoreMethod', 'guide'];
  const basic = kind === 'activities' && row ? <ActivityBasic row={row} /> : basicInfo(fields, permission, row);
  const Container = kind === 'activities' ? ActivityDetailLayout : DetailPage;
  return (
    <Container
      open
      onClose={close}
      title={row?.name ?? titles[kind]}
      actions={
        <Space>
          <Button onClick={reload}>{common.refresh}</Button>
          {row && permission.can('update') && <Button onClick={() => edit(true)}>{m.edit}</Button>}
          {row && <StateAction row={row} kind={kind} saved={reload} />}
        </Space>
      }
      summary={
        <>
          <DecisionNote id="survey360" />
          {row && kind === 'activities' && permission.field('status').visible && <Tag>{display(row.status)}</Tag>}
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
      <QuestionnaireEditor
        path={`${BASE}${surveyPath(kind)}`}
        title={createTitles[kind]}
        row={row}
        close={close}
        saved={saved}
      />
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
  const writer = useSurveyForm(`${BASE}/activities`, row, activityValues);
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
      {
        key: 'questionnaires',
        label: m.questionnaires,
        children: <SurveyList kind="questionnaires" activityId={id} />,
      },
      { key: 'relations', label: m.relations, children: <Relations activityId={id} /> },
      { key: 'progress', label: m.progress, children: <ReadingPanel activityId={id} kind="progress" /> },
      { key: 'data', label: ui.data, children: <ReadingPanel activityId={id} kind="data" /> },
      { key: 'reports', label: ui.personal, children: <ReadingPanel activityId={id} kind="reports" /> },
      { key: 'team', label: ui.team, children: <Unverified /> },
      { key: 'report', label: ui.report, children: <Unverified /> },
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

function SurveyFilters({
  kind,
  visible,
  status,
  onChange,
}: {
  kind: Kind;
  visible: (field: string) => boolean;
  status: string;
  onChange(value: string): void;
}) {
  const states = ['', 'draft', 'enabled', 'disabled'];
  return (
    <>
      {kind === 'activities' && visible('status') && (
        <Tabs
          activeKey={status}
          onChange={(value) => {
            onChange(value);
          }}
          items={[
            ...states.map((key) => ({ key, label: key ? display(key) : m.all })),
            { key: 'followed', label: ui.followed, disabled: true },
          ]}
        />
      )}
      <Filters
        fields={columnFilters(
          columns[kind]!.filter(([key]) =>
            kind === 'activities' ? ['name', 'scene', 'creator', 'createdAt'].includes(key) : key === 'name',
          ),
          visible,
        )}
      />
    </>
  );
}

function listColumns(
  kind: Kind,
  visible: (field: string) => boolean,
  select: (id: string) => void,
  reload: () => void,
) {
  return alignedColumns(
    kind,
    visible,
    {
      createdBy: () => missing,
      name: (value, row) => (
        <Button type="link" onClick={() => select(row.id)}>
          {textValue(value)}
        </Button>
      ),
    },
    {
      width: kind === 'questionnaires' ? 116 : 122,
      render: (row) => (
        <Space size="small">
          {kind === 'activities' && !visible('name') && (
            <Button type="link" onClick={() => select(row.id)}>
              {common.view}
            </Button>
          )}
          {kind === 'activities' ? (
            <StateAction row={row} kind={kind} saved={reload} />
          ) : (
            <Button type="link" onClick={() => select(row.id)}>
              {m.preview}
            </Button>
          )}
          <PendingButtons labels={kind === 'activities' ? [ui.delete, ui.transfer] : [ui.export]} />
        </Space>
      ),
    },
  );
}

function TemplateLibrary() {
  const [builtin, setBuiltin] = useState(false);
  return (
    <>
      <Tabs
        activeKey={builtin ? 'builtin' : 'custom'}
        onChange={(key) => setBuiltin(key === 'builtin')}
        items={[
          { key: 'custom', label: ui.custom },
          { key: 'builtin', label: ui.builtin },
        ]}
      />
      {builtin ? (
        <div className="survey-panel">
          <Filters fields={[ui.templateName, ui.category]} />
          <PendingButtons labels={[ui.enterBuiltin]} />
          <Unverified missingContract />
          <Table<Row>
            rowKey="id"
            dataSource={[]}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: ui.missing }}
            columns={alignedColumns(
              'builtin',
              () => true,
              {},
              {
                width: 122,
                render: () => null,
              },
            )}
          />
        </div>
      ) : (
        <SurveyList kind="templates" />
      )}
    </>
  );
}
