import { CreateEntry } from '../evaluation/CreateEntry.js';
import { Button, Descriptions, Space, Table } from 'antd';
import { useState } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import { DetailPage } from '../foundation/templates.js';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { PageState } from '../foundation/PageState.js';
import type { PageResult } from '../foundation/client.js';
import { Failure, RemoteSelect, useRead } from '../evaluation/runtime.js';
import { useRecordForm } from '../evaluation/useRecordForm.js';
import type { Row } from '../evaluation/model.js';
import { m as common, textValue } from '../evaluation/messages.js';
import { m } from './messages.js';
import { validateQuestionnaireSelection } from './model.js';
const BASE = '/api/tenant/survey360';
const OBJECT = 'Survey360.Relation';
export function Relations({ activityId }: { activityId: string }) {
  const permission = usePermissions(OBJECT);
  const path = `${BASE}/activities/${activityId}/objects`;
  const allowed = !!permission.snapshot.objects[OBJECT];
  const list = useRead<PageResult<Row>>(allowed ? path : undefined);
  const [selected, select] = useState<Row>();
  const [creating, create] = useState(false);
  if (!allowed) return <PageState kind="forbidden" />;
  return (
    <>
      <p className="r3b-note">{m.relationHint}</p>
      <Failure error={list.error} retry={list.reload} />
      <Space>
        <Button onClick={list.reload}>{common.refresh}</Button>
        {permission.can('create', 'list') &&
          permission.field('personId').editable &&
          permission.field('questionnaireIds').editable && (
            <Button type="primary" onClick={() => create(true)}>
              {m.addObject}
            </Button>
          )}
      </Space>
      <Table
        rowKey="id"
        dataSource={list.data?.items ?? []}
        loading={list.loading}
        pagination={{ defaultPageSize: 15 }}
        columns={[
          ...(permission.field('person').visible
            ? [{ title: m.person, dataIndex: 'person', render: (v: { name?: string }) => textValue(v?.name) }]
            : []),
          ...(permission.field('questionnaireIds').visible
            ? [
                {
                  title: m.questionnaires,
                  dataIndex: 'questionnaireIds',
                  render: (ids: string[] | undefined) => ids?.join('、') ?? common.noValue,
                },
              ]
            : []),
          {
            title: m.actions,
            key: 'actions',
            render: (_: unknown, row: Row) => (
              <Button type="link" onClick={() => select(row)}>
                {m.appraisers}
              </Button>
            ),
          },
        ]}
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
  const writer = useRecordForm(path);
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
