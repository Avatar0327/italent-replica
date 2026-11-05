import { CreateEntry } from '../evaluation/CreateEntry.js';
import { Button, Descriptions, Space, Table, Tabs } from 'antd';
import { useState } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import { DetailPage } from '../foundation/templates.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { PageState } from '../foundation/PageState.js';
import type { PageResult } from '../foundation/client.js';
import { Failure, RemoteSelect, useRead } from '../evaluation/runtime.js';
import { useSurveyForm } from './useSurveyForm.js';
import type { Row } from '../evaluation/model.js';
import { m as common, textValue } from '../evaluation/messages.js';
import { m } from './messages.js';
import { validateQuestionnaireSelection } from './model.js';
import { alignedColumns, Filters, PendingButtons, SurveyTable } from './Presentation.js';
import { ui } from './alignment.js';
const BASE = '/api/tenant/survey360';
const OBJECT = 'Survey360.Relation';
export function Relations({ activityId }: { activityId: string }) {
  const permission = usePermissions(OBJECT);
  const person = usePermissions('Survey360.Person');
  const questionnaire = usePermissions('Survey360.Questionnaire');
  const visible = (field: string) =>
    field.startsWith('person.')
      ? permission.field('person').visible && person.field(field.slice(7)).visible
      : permission.field(field).visible;
  const path = `${BASE}/activities/${activityId}/objects`;
  const allowed = !!permission.snapshot.objects[OBJECT];
  const list = useRead<PageResult<Row>>(allowed ? path : undefined);
  const library = useRead<PageResult<Row>>(
    allowed && permission.field('questionnaireIds').visible && questionnaire.field('name').visible
      ? `${BASE}/questionnaires`
      : undefined,
  );
  const names = new Map(library.data?.items.map((row) => [row.id, row.name]));
  const [selected, select] = useState<Row>();
  const [creating, create] = useState(false);
  if (!allowed) return <PageState kind="forbidden" />;
  return (
    <>
      <Tabs
        items={[
          { key: 'objects', label: m.person },
          { key: 'appraisers', label: m.appraiser, disabled: true },
          { key: 'confirmers', label: ui.confirmer, disabled: true },
        ]}
      />
      <p className="r3b-note">
        {m.relationHint} {ui.unverified}
      </p>
      <Filters
        fields={[
          [ui.person, 'person.name'],
          [ui.email, 'person.email'],
          [ui.mobile],
          [ui.department],
          [ui.position],
          [ui.advanced],
        ]
          .filter(([, field]) => !field || visible(field))
          .map(([label]) => label!)}
      />
      <Failure error={list.error} retry={list.reload} />
      <Space className="survey-toolbar">
        <PendingButtons labels={ui.relationTools} />
        <Button onClick={list.reload}>{common.refresh}</Button>
        {permission.can('create', 'list') &&
          permission.field('personId').editable &&
          permission.field('questionnaireIds').editable && (
            <Button type="primary" onClick={() => create(true)}>
              {m.addObject}
            </Button>
          )}
      </Space>
      <Failure error={library.error} retry={library.reload} />
      <SurveyTable
        rows={list.data?.items ?? []}
        loading={list.loading}
        error={list.error}
        reload={list.reload}
        selection
        columns={relationColumns(visible, names, select)}
      />
      {creating && (
        <CreateEntry path={path} title={m.addObject} close={() => create(false)}>
          <RelationEditor path={path} close={() => create(false)} saved={list.reload} />
        </CreateEntry>
      )}
      {selected && (
        <Appraisers key={selected.id} row={selected} path={`${path}/${selected.id}`} close={() => select(undefined)} />
      )}
    </>
  );
}
function Appraisers({ row, path, close }: { row: Row; path: string; close(): void }) {
  const permission = usePermissions(OBJECT);
  const list = useRead<PageResult<Row>>(`${path}/appraisers`);
  const [creating, create] = useState(false);
  return (
    <DetailPage
      open
      onClose={close}
      title={m.appraisers}
      summary={
        <>
          <p>{m.anonymity}</p>
          <Failure error={list.error} retry={list.reload} />
          {permission.field('person').visible && (
            <Descriptions
              items={[{ key: 'person', label: m.person, children: textValue((row.person as { name?: string })?.name) }]}
            />
          )}
        </>
      }
      actions={
        <Space>
          <Button onClick={list.reload}>{common.refresh}</Button>
          {permission.can('create', 'list') &&
            permission.field('appraiserPersonId').editable &&
            permission.field('roleId').editable && (
              <Button type="primary" onClick={() => create(true)}>
                {m.addAppraiser}
              </Button>
            )}
        </Space>
      }
      sections={[
        {
          key: 'appraisers',
          title: m.appraiser,
          children: (
            <>
              <Table
                rowKey="id"
                loading={list.loading}
                dataSource={list.data?.items ?? []}
                pagination={{ defaultPageSize: 15 }}
                columns={[
                  ...(permission.field('appraiser').visible
                    ? [
                        {
                          title: m.appraiser,
                          dataIndex: 'appraiser',
                          render: (v: { name?: string }) => textValue(v?.name),
                        },
                      ]
                    : []),
                  ...(permission.field('roleName').visible
                    ? [{ title: m.roleName, dataIndex: 'roleName', render: textValue }]
                    : []),
                ]}
              />
              {creating && (
                <CreateEntry path={`${path}/appraisers`} title={m.addAppraiser} close={() => create(false)}>
                  <RelationEditor
                    appraiser
                    path={`${path}/appraisers`}
                    close={() => create(false)}
                    saved={list.reload}
                  />
                </CreateEntry>
              )}
            </>
          ),
        },
      ]}
    />
  );
}
function RelationEditor({
  path,
  appraiser,
  close,
  saved,
}: {
  path: string;
  appraiser?: boolean;
  close(): void;
  saved(): void;
}) {
  const permission = usePermissions(OBJECT);
  const writer = useSurveyForm(path);
  const fields: FormField[] = [
    {
      name: 'personId',
      label: m.personId,
      access: permission.field(appraiser ? 'appraiserPersonId' : 'personId'),
      control: <RemoteSelect path={`${BASE}/people`} />,
      rules: [{ required: true, message: common.required }],
    },
    appraiser
      ? {
          name: 'roleId',
          label: m.roleId,
          access: permission.field('roleId'),
          control: <RemoteSelect path={`${BASE}/roles`} />,
          rules: [{ required: true, message: common.required }],
        }
      : {
          name: 'questionnaireIds',
          label: m.questionnaireIds,
          access: permission.field('questionnaireIds'),
          control: (
            <RemoteSelect
              path={`${BASE}/questionnaires`}
              multiple
              usable={(row) => row.status === 'enabled' || row.status === 'used'}
            />
          ),
          rules: [
            {
              validator: async (_, value: string[] | undefined) => {
                if (!validateQuestionnaireSelection(value ?? [])) throw new Error(m.selectionInvalid);
              },
            },
          ],
        },
  ];
  return (
    <FormOverlay
      open
      recordKey="new-relation"
      submission={writer}
      title={appraiser ? m.addAppraiser : m.addObject}
      groups={[{ title: m.relations, fields }]}
      onClose={close}
      onSubmit={async (values) => {
        await writer.save(
          values,
          fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name),
          'POST',
        );
        writer.clear();
        saved();
        close();
      }}
    />
  );
}

function relationColumns(
  visible: (field: string) => boolean,
  names: Map<string, string | undefined>,
  select: (row: Row) => void,
) {
  return alignedColumns(
    'objects',
    visible,
    {
      personName: (_, row) => textValue((row.person as { name?: string })?.name),
      email: (_, row) => textValue((row.person as { email?: string })?.email),
      questionnaireIds: (ids) =>
        Array.isArray(ids) ? ids.map((id: string) => names.get(id) ?? common.noValue).join('、') : common.noValue,
    },
    {
      title: m.appraiser,
      width: 116,
      render: (row) => (
        <Button type="link" onClick={() => select(row)}>
          {m.appraisers}
        </Button>
      ),
    },
  );
}
