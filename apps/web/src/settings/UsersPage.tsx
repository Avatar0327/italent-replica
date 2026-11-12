import { userColumns } from './user-columns.js';
import { Button, Input } from 'antd';
import { useRef, useState } from 'react';
import { ApiError } from '../foundation/client.js';
import { FormOverlay } from '../foundation/FormOverlay.js';
import { useApiClient } from '../foundation/Session.js';
import { ListPage } from '../foundation/templates.js';
import { settingsApi } from './api.js';
import { base, type User } from './model.js';
import { Facts, Notice, RemoteDetail, Status } from './parts.js';
import type { SettingsProps } from './SettingsPage.js';
import { useSettingsList, useListInstant, useRowSelection } from './list-support.js';
import { ListFilters, type ListFilterField } from './ListFilters.js';
import { m } from './messages.js';
const userFilterFields: ListFilterField[] = [
  { name: 'q', label: m.accountSearch },
  { name: 'contactEmail', label: m.email },
  {
    name: 'accountStatus',
    label: m.accountStatus,
    defaultValue: 'active',
    options: [
      { value: 'active', label: m.active },
      { value: 'disabled', label: m.disabled },
    ],
  },
  {
    name: 'type',
    label: m.userType,
    options: [
      { value: 'internal', label: m.users },
      { value: 'external', label: m.external },
    ],
  },
];

export function UsersPage({ code, title, editable }: SettingsProps) {
  const list = useSettingsList<User>('users', {
    type: code.split('.')[1]!,
    ...(code === 'users.all' ? { accountStatus: 'active' } : {}),
  });
  const { page, setPage } = list;
  const instant = useListInstant();
  const selection = useRowSelection(list.data?.items ?? [], (row) => row.userId);
  const [detail, setDetail] = useState<string>();
  const [create, setCreate] = useState(false);
  return (
    <>
      <Notice text={m.internalNotice} />
      <ListPage
        title={title}
        rowKey="userId"
        data={list.data ?? { items: [] }}
        page={page}
        onPageChange={setPage}
        loading={list.loading}
        error={list.error}
        retry={list.refresh}
        filters={code === 'users.all' && <ListFilters apply={list.apply} fields={userFilterFields} />}
        actions={
          <>
            <Button onClick={list.refresh}>{m.refresh}</Button>
            {editable && code !== 'users.internal' && (
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
          ...(code === 'users.all' ? selection : []),
          ...userColumns(code === 'users.internal', setDetail, instant, code === 'users.all'),
        ]}
      />
      {detail && (
        <RemoteDetail<User> path={`${base}/users/${detail}`} title={m.detail} close={() => setDetail(undefined)}>
          {(user) => (
            <Facts
              items={[
                [m.displayName, user.displayName],
                [m.email, user.contactEmail],
                [m.businessIdentity, user.businessIdentity],
                [m.status, <Status value={user.membershipStatus} />],
                [m.userId, user.userId],
                [m.revision, user.membershipRevision],
              ]}
            />
          )}
        </RemoteDetail>
      )}
      {create && <UserForm close={() => setCreate(false)} refresh={list.refresh} editable={editable} />}
    </>
  );
}

function UserForm({ close, refresh, editable }: { close(): void; refresh(): void; editable: boolean }) {
  const api = useApiClient();
  const uncertain = useRef(false);
  const access = { visible: true, editable };
  return (
    <FormOverlay
      open
      recordKey="new-user"
      title={m.new + m.external}
      onClose={close}
      groups={[
        {
          title: m.basic,
          fields: [
            {
              name: 'displayName',
              label: m.displayName,
              access,
              control: <Input maxLength={100} />,
              rules: [{ required: true, whitespace: true, message: m.required }],
            },
            {
              name: 'email',
              label: m.email,
              access,
              control: <Input maxLength={320} />,
              rules: [
                { required: true, message: m.required },
                { type: 'email', message: m.invalid },
              ],
            },
            {
              name: 'businessIdentity',
              label: m.businessIdentity,
              access,
              control: <Input maxLength={50} />,
              rules: [{ required: true, whitespace: true, message: m.required }],
            },
          ],
        },
      ]}
      onSubmit={async (values) => {
        if (uncertain.current) throw new ApiError(0, 'UNKNOWN_RESULT', 'unknown', m.unknown);
        try {
          await settingsApi(api).createUser(values);
          refresh();
        } catch (error) {
          if (error instanceof ApiError && error.kind === 'unknown') uncertain.current = true;
          throw error;
        }
      }}
    />
  );
}
