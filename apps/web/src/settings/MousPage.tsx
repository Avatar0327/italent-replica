import { Button, Input, Tabs } from 'antd';
import { useState } from 'react';
import { newCommand, type PageResult } from '../foundation/client.js';
import { FormOverlay } from '../foundation/FormOverlay.js';
import { useApiClient } from '../foundation/Session.js';
import { ListPage } from '../foundation/templates.js';
import { base, listPath, scopeInput, type Mou } from './model.js';
import { Facts, Notice, RemoteDetail, Status } from './parts.js';
import { RangeInput, ScopeEditor } from './ScopeEditor.js';
import type { SettingsProps } from './SettingsPage.js';
import { useResource } from './useResource.js';
import { useWrite } from './useWrite.js';
import { m } from './messages.js';
export function MousPage({ code, title, editable }: SettingsProps) {
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const list = useResource<PageResult<Mou>>(listPath(code, page));
  const [detail, setDetail] = useState<string>();
  const [create, setCreate] = useState(false);
  const content = (
    <>
      <Notice text={m.scopeNotice} />
      <ListPage
        title={title}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        data={list.data ?? { items: [] }}
        loading={list.loading}
        error={list.error}
        retry={list.refresh}
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
            render: (name: string, row: Mou) => (
              <Button type="link" onClick={() => setDetail(row.id)}>
                {name}
              </Button>
            ),
          },
          { title: m.code, dataIndex: 'code' },
          { title: m.description, dataIndex: 'description' },
          { title: m.parentId, dataIndex: 'parentId' },
          { title: m.status, dataIndex: 'status', render: (value: string) => <Status value={value} /> },
        ]}
      />
      {detail && <MouDetails detail={detail} close={() => setDetail(undefined)} />}
      {create && <MouForm close={() => setCreate(false)} refresh={list.refresh} editable={editable} />}
    </>
  );
  return (
    <Tabs
      items={[
        { key: 'mous', label: m.mous, children: content },
        ...(editable ? [{ key: 'scope', label: m.scope, children: <ScopeEditor /> }] : []),
      ]}
    />
  );
}

function MouForm({ close, refresh, editable }: { close(): void; refresh(): void; editable: boolean }) {
  const api = useApiClient();
  const writer = useWrite();
  const access = { visible: true, editable };
  return (
    <FormOverlay
      open
      recordKey="new-mou"
      title={m.new + m.mous}
      onClose={close}
      initialValues={{ orgRanges: [] }}
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
            { name: 'description', label: m.description, access, control: <Input.TextArea maxLength={500} /> },
            { name: 'orgRanges', label: m.ranges, access, control: <RangeInput /> },
          ],
        },
      ]}
      onSubmit={(values) =>
        writer.run(async () => {
          const ranges = scopeInput({ kind: 'org_range', orgRanges: values.orgRanges ?? [] });
          await api.request(`${base}/mous`, {
            method: 'POST',
            command: newCommand(
              {
                ...values,
                name: String(values.name).trim(),
                description: values.description ?? '',
                orgRanges: ranges.orgRanges,
                parentId: null,
                status: 'active',
              },
              0,
            ),
          });
          refresh();
        })
      }
    />
  );
}

function MouDetails({ detail, close }: { detail: string; close(): void }) {
  return (
    <RemoteDetail<Mou> path={`${base}/mous/${detail}`} title={m.mous} close={close}>
      {(mou) => (
        <>
          <Facts
            items={[
              [m.name, mou.name],
              [m.code, mou.code],
              [m.description, mou.description],
              [m.parentId, mou.parentId],
              [m.revision, mou.revision],
            ]}
          />
          <h3>{m.orgScope}</h3>
          {(mou.orgRanges ?? []).map((range) => (
            <p key={`${range.orgId}/${range.dimension}`}>
              {range.orgId} · {range.dimension} · {range.includeDescendants ? m.descendants : m.no}
            </p>
          ))}
        </>
      )}
    </RemoteDetail>
  );
}
