import { Button, Input, Table, Tabs } from 'antd';
import { useState } from 'react';
import { newCommand, type PageResult } from '../foundation/client.js';
import { FormOverlay } from '../foundation/FormOverlay.js';
import { useApiClient } from '../foundation/Session.js';
import { ListPage } from '../foundation/templates.js';
import { base, type Profile } from './model.js';
import { Facts, Notice, RemoteDetail, Status } from './parts.js';
import type { SettingsProps } from './SettingsPage.js';
import { useResource } from './useResource.js';
import { useWrite } from './useWrite.js';
import { m } from './messages.js';
export function ProfilesPage({ title, editable }: SettingsProps) {
  const list = useResource<PageResult<Profile>>(`${base}/profiles`);
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<string>();
  const [create, setCreate] = useState(false);
  const items = (list.data?.items ?? []).filter((row) => `${row.name} ${row.code}`.includes(query));
  return (
    <>
      <Notice text={m.profileNotice} />
      <ListPage
        title={title}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        loading={list.loading}
        error={list.error}
        retry={list.refresh}
        data={{ items: items.slice((page.page - 1) * page.pageSize, page.page * page.pageSize), total: items.length }}
        filters={
          <Input.Search
            aria-label={m.search}
            placeholder={m.search}
            onSearch={(value) => {
              setQuery(value);
              setPage({ ...page, page: 1 });
            }}
          />
        }
        actions={
          <>
            <Button onClick={list.refresh}>{m.refresh}</Button>
            {editable && (
              <Button
                type="primary"
                onClick={() => {
                  setCreate(true);
                }}
              >
                {m.new}
              </Button>
            )}
          </>
        }
        columns={[
          {
            title: m.name,
            dataIndex: 'name',
            render: (name: string, row: Profile) => (
              <Button type="link" onClick={() => setDetail(row.id)}>
                {name}
              </Button>
            ),
          },
          { title: m.code, dataIndex: 'code' },
          { title: m.apps, dataIndex: 'apps', render: (apps: string[]) => apps.join('、') },
          { title: m.source, dataIndex: 'source', render: (value: string) => <Status value={value} /> },
          { title: m.description, dataIndex: 'description' },
          { title: m.operation, render: (_: unknown, row: Profile) => (row.autoHeld ? m.autoHeld : m.empty) },
        ]}
      />
      {detail && <ProfileDetails detail={detail} close={() => setDetail(undefined)} />}
      {create && <ProfileForm close={() => setCreate(false)} refresh={list.refresh} editable={editable} />}
    </>
  );
}

function ProfileForm({ close, refresh, editable }: { close(): void; refresh(): void; editable: boolean }) {
  const api = useApiClient();
  const writer = useWrite();
  const access = { visible: true, editable };
  return (
    <FormOverlay
      open
      recordKey="new-profile"
      title={m.new + m.profiles}
      onClose={close}
      groups={[
        {
          title: m.basic,
          fields: [
            {
              name: 'name',
              label: m.name,
              access,
              control: <Input maxLength={100} />,
              rules: [{ required: true, whitespace: true, message: m.required }],
            },
            {
              name: 'code',
              label: m.code,
              access,
              control: <Input maxLength={64} />,
              rules: [{ required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, message: m.invalid }],
            },
            {
              name: 'apps',
              label: m.apps,
              access,
              control: <Input placeholder={m.appsHint} />,
              rules: [{ pattern: /^[A-Za-z][A-Za-z0-9_.]{0,63}(,[A-Za-z][A-Za-z0-9_.]{0,63})*$/, message: m.invalid }],
            },
            { name: 'description', label: m.description, access, control: <Input.TextArea maxLength={500} /> },
          ],
        },
      ]}
      onSubmit={(values) =>
        writer.run(async () => {
          await api.request(`${base}/profiles`, {
            method: 'POST',
            command: newCommand({
              ...values,
              name: String(values.name).trim(),
              apps: values.apps ? String(values.apps).split(',') : [],
              description: values.description ?? '',
              licenseType: null,
            }),
          });
          refresh();
        })
      }
    />
  );
}

function ProfileDetails({ detail, close }: { detail: string; close(): void }) {
  return (
    <RemoteDetail<Profile> path={`${base}/profiles/${detail}`} title={m.profiles} close={close}>
      {(profile) => (
        <>
          <Facts
            items={[
              [m.name, profile.name],
              [m.code, profile.code],
              [m.apps, profile.apps.join('、')],
              [m.description, profile.description],
              [m.revision, profile.revision],
            ]}
          />
          <Tabs
            items={(profile.objects ?? []).map((object) => ({
              key: object.objectCode,
              label: object.objectCode,
              children: (
                <>
                  <h3>{m.fields}</h3>
                  <Table
                    rowKey="fieldCode"
                    pagination={false}
                    dataSource={object.fields}
                    columns={[
                      { title: m.field, dataIndex: 'fieldCode' },
                      { title: m.read, dataIndex: 'view', render: (v: boolean) => (v ? m.yes : m.no) },
                      { title: m.write, dataIndex: 'edit', render: (v: boolean) => (v ? m.yes : m.no) },
                    ]}
                  />
                  <h3>{m.buttons}</h3>
                  <Table
                    rowKey={(row) => `${row.buttonCode}/${row.level}`}
                    pagination={false}
                    dataSource={object.buttons}
                    columns={[
                      { title: m.code, dataIndex: 'buttonCode' },
                      { title: m.source, dataIndex: 'level' },
                    ]}
                  />
                </>
              ),
            }))}
          />
        </>
      )}
    </RemoteDetail>
  );
}
