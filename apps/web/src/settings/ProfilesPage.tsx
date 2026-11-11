import { Button, Input } from 'antd';
import { useState } from 'react';
import { newCommand } from '../foundation/client.js';
import { FormOverlay } from '../foundation/FormOverlay.js';
import { useApiClient } from '../foundation/Session.js';
import { ListPage } from '../foundation/templates.js';
import { base, type Profile } from './model.js';
import { Notice } from './parts.js';
import { ProfileDetails } from './ProfileDetails.js';
import type { SettingsProps } from './SettingsPage.js';
import { useSettingsList, useListInstant } from './list-support.js';
import { ListFilters } from './ListFilters.js';
import { profileColumns } from './profile-columns.js';
import { useWrite } from './useWrite.js';
import { m } from './messages.js';
export function ProfilesPage({ title, editable }: SettingsProps) {
  const list = useSettingsList<Profile>('profiles');
  const { page, setPage } = list;
  const instant = useListInstant();
  const [detail, setDetail] = useState<string>();
  const [create, setCreate] = useState(false);
  if (detail)
    return (
      <ProfileDetails
        id={detail}
        editable={editable}
        close={() => {
          setDetail(undefined);
          list.refresh();
        }}
      />
    );
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
        data={list.data ?? { items: [] }}
        filters={
          <ListFilters
            apply={list.apply}
            fields={[
              { name: 'name', label: m.name },
              { name: 'code', label: m.code },
              { name: 'app', label: m.apps, max: 64, pattern: /^[A-Za-z][A-Za-z0-9_.]{0,63}$/ },
            ]}
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
        columns={profileColumns(setDetail, instant)}
      />
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
