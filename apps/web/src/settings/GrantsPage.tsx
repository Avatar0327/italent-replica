import { Button, Input, Select, Space } from 'antd';
import { useState } from 'react';
import type { PageResult } from '../foundation/client.js';
import { FormOverlay } from '../foundation/FormOverlay.js';
import { useApiClient } from '../foundation/Session.js';
import { DetailPage, ListPage } from '../foundation/templates.js';
import { settingsApi } from './api.js';
import { base, validId, type Grant, type Profile, type GrantReceipt } from './model.js';
import { Facts, Notice, Status } from './parts.js';
import { ScopeEditor } from './ScopeEditor.js';
import type { SettingsProps } from './SettingsPage.js';
import { useResource } from './useResource.js';
import { useWrite } from './useWrite.js';
import { m } from './messages.js';
import { useGrantReceipt } from './grant-receipt.js';
export function GrantsPage({ title, editable, canScope }: SettingsProps & { canScope: boolean }) {
  const receipt = useGrantReceipt();
  const list = useResource<PageResult<Grant>>(`${base}/grants`);
  const options = useResource<PageResult<Pick<Profile, 'id' | 'name' | 'code'>>>(
    editable ? `${base}/grantable-profiles` : null,
  );
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [selected, setSelected] = useState<Grant>();
  const [scopeUser, setScopeUser] = useState<string>();
  const [form, setForm] = useState<'create' | 'revoke'>();
  const items = list.data?.items ?? [];
  return (
    <>
      <Notice text={m.grantNotice} />
      {receipt.notice}
      <ListPage
        title={title}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        loading={list.loading}
        error={list.error}
        retry={list.refresh}
        data={{ items: items.slice((page.page - 1) * page.pageSize, page.page * page.pageSize), total: items.length }}
        actions={
          <>
            <Button onClick={list.refresh}>{m.refresh}</Button>
            {editable && (
              <Button
                type="primary"
                onClick={() => {
                  setForm('create');
                }}
              >
                {m.new}
              </Button>
            )}
          </>
        }
        columns={grantColumns(options.data?.items ?? [], editable, canScope, setSelected, setScopeUser, (row) => {
          setSelected(row);
          setForm('revoke');
        })}
      />
      {selected && !form && <GrantDetails selected={selected} close={() => setSelected(undefined)} />}
      {scopeUser && (
        <DetailPage
          open
          title={m.scope}
          onClose={() => setScopeUser(undefined)}
          sections={[{ key: 'scope', title: m.scope, children: <ScopeEditor initialUser={scopeUser} /> }]}
        />
      )}
      {form && (
        <GrantForm
          form={form}
          selected={selected}
          editable={editable}
          onGranted={receipt.accept}
          close={() => {
            setForm(undefined);
            setSelected(undefined);
          }}
          refresh={list.refresh}
        />
      )}
    </>
  );
}

function GrantForm({
  form,
  selected,
  editable,
  close,
  refresh,
  onGranted,
}: {
  form: 'create' | 'revoke';
  selected?: Grant;
  editable: boolean;
  close(): void;
  refresh(): void;
  onGranted(receipt: GrantReceipt): void;
}) {
  const api = useApiClient();
  const writer = useWrite();
  const access = { visible: true, editable };
  const options = useResource<PageResult<Pick<Profile, 'id' | 'name' | 'code'>>>(`${base}/grantable-profiles`);
  return (
    <FormOverlay
      open
      recordKey={form === 'revoke' ? `${selected?.id}/${selected?.revision}` : 'new-grant'}
      title={form === 'revoke' ? m.revokeTitle : m.new + m.grants}
      onClose={close}
      onRefresh={() => {
        close();
        refresh();
      }}
      groups={
        form === 'revoke'
          ? []
          : [
              {
                title: m.basic,
                fields: [
                  {
                    name: 'userId',
                    label: m.userId,
                    access,
                    control: <Input placeholder={m.userHint} />,
                    rules: [
                      {
                        required: true,
                        validator: async (_: unknown, value: unknown) => {
                          if (!validId(value)) throw new Error(m.invalid);
                        },
                      },
                    ],
                  },
                  {
                    name: 'profileId',
                    label: m.profileId,
                    access,
                    control: (
                      <Select
                        loading={options.loading}
                        options={options.data?.items.map((item) => ({
                          value: item.id,
                          label: `${item.name} (${item.code})`,
                        }))}
                        notFoundContent={options.error ? m.noPermission : m.noMatch}
                      />
                    ),
                    rules: [{ required: true, message: m.required }],
                  },
                ],
              },
            ]
      }
      onSubmit={(values) =>
        writer.run(async () => {
          if (form === 'revoke' && selected) await settingsApi(api).revoke(selected);
          else onGranted(await settingsApi(api).createGrant(values));
          refresh();
        })
      }
    />
  );
}

function grantColumns(
  profiles: Pick<Profile, 'id' | 'name' | 'code'>[],
  editable: boolean,
  canScope: boolean,
  setSelected: (row: Grant) => void,
  setScopeUser: (id: string) => void,
  revoke: (row: Grant) => void,
) {
  return [
    {
      title: m.userId,
      dataIndex: 'userId',
      render: (value: string, row: Grant) => (
        <Button type="link" onClick={() => setSelected(row)}>
          {value}
        </Button>
      ),
    },
    {
      title: m.profileId,
      dataIndex: 'profileId',
      render: (id: string) => profiles.find((item) => item.id === id)?.name ?? id,
    },
    { title: m.source, dataIndex: 'source', render: (value: string) => <Status value={value} /> },
    { title: m.status, dataIndex: 'status', render: (value: string) => <Status value={value} /> },
    {
      title: m.operation,
      render: (_: unknown, row: Grant) => (
        <Space>
          {canScope && (
            <Button type="link" onClick={() => setScopeUser(row.userId)}>
              {m.scope}
            </Button>
          )}
          {editable && row.source === 'manual' && row.status === 'active' && (
            <Button
              type="link"
              onClick={() => {
                revoke(row);
              }}
            >
              {m.revoke}
            </Button>
          )}
        </Space>
      ),
    },
  ];
}

function GrantDetails({ selected, close }: { selected: Grant; close(): void }) {
  return (
    <DetailPage
      open
      title={m.grants}
      onClose={close}
      sections={[
        {
          key: 'grant',
          title: m.basic,
          children: (
            <Facts
              items={[
                [m.userId, selected.userId],
                [m.profileId, selected.profileId],
                [m.status, <Status value={selected.status} />],
                [m.revision, selected.revision],
              ]}
            />
          ),
        },
      ]}
    />
  );
}
