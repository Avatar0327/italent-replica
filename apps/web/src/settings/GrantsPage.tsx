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
import { useSettingsList, useRowSelection, columnGear, mouText, textValue } from './list-support.js';
import { ListFilters, type ListFilterValues } from './ListFilters.js';
import { useGrantReceipt } from './grant-receipt.js';
export function GrantsPage({ title, editable, canScope }: SettingsProps & { canScope: boolean }) {
  const receipt = useGrantReceipt();
  const list = useSettingsList<Grant>('grants');
  const { page, setPage } = list;
  const selection = useRowSelection(list.data?.items ?? [], (row) => row.id);
  const [selected, setSelected] = useState<Grant>();
  const [scopeUser, setScopeUser] = useState<string>();
  const [form, setForm] = useState<'create' | 'revoke'>();
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
        data={list.data ?? { items: [] }}
        filters={<GrantFilters apply={list.apply} />}
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
        columns={[
          ...selection,
          ...grantColumns(editable, canScope, setSelected, setScopeUser, (row) => {
            setSelected(row);
            setForm('revoke');
          }),
        ]}
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
  editable: boolean,
  canScope: boolean,
  setSelected: (row: Grant) => void,
  setScopeUser: (id: string) => void,
  revoke: (row: Grant) => void,
) {
  return [
    {
      title: m.displayName,
      dataIndex: 'userName',
      width: 158,
      render: (value: string, row: Grant) => (
        <Button type="link" onClick={() => setSelected(row)}>
          {textValue(value)}
        </Button>
      ),
    },
    { title: m.listEmail, dataIndex: 'userEmail', width: 218, render: textValue },
    { title: m.phone, dataIndex: 'phone', width: 158, render: textValue },
    { title: m.profileId, dataIndex: 'profileName', width: 158, render: textValue },
    { title: m.mous, dataIndex: 'mous', width: 158, render: mouText },
    { title: m.product, dataIndex: 'apps', width: 158, render: (apps?: string[]) => apps?.join('、') || m.empty },
    {
      title: m.operation,
      width: 160,
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
    columnGear,
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

function GrantFilters({ apply }: { apply(values: ListFilterValues): void }) {
  return (
    <ListFilters
      apply={apply}
      fields={[
        { name: 'q', label: m.personSearch },
        {
          name: 'profileId',
          label: m.profileId,
          candidates: 'grants/profile-candidates',
        },
        { name: 'mouId', label: m.mous, candidates: 'grants/mou-candidates' },
        {
          name: 'status',
          label: m.status,
          options: [
            { value: 'active', label: m.active },
            { value: 'revoked', label: m.revoked },
          ],
        },
      ]}
    />
  );
}
