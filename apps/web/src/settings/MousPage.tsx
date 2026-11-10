import { Button, Input, Tabs } from 'antd';
import { useState } from 'react';
import { newCommand } from '../foundation/client.js';
import { FormOverlay } from '../foundation/FormOverlay.js';
import { useApiClient } from '../foundation/Session.js';
import { MouTreeTable } from './MouTreeTable.js';
import { base, scopeInput, type Mou, type MouTreeNode } from './model.js';
import { Facts, Notice, RemoteDetail } from './parts.js';
import { RangeInput, ScopeEditor } from './ScopeEditor.js';
import type { SettingsProps } from './SettingsPage.js';
import { useResource } from './useResource.js';
import { useWrite } from './useWrite.js';
import { m } from './messages.js';
export function MousPage({ title, editable }: SettingsProps) {
  const [filters, setFilters] = useState({ status: 'active', q: '' });
  const query = new URLSearchParams({ status: filters.status, ...(filters.q ? { q: filters.q } : {}) });
  const list = useResource<{ items: MouTreeNode[]; total: number }>(`${base}/mous/tree?${query}`);
  const [detail, setDetail] = useState<string>();
  const [create, setCreate] = useState(false);
  const content = (
    <>
      <Notice text={m.mouNotice} />
      <MouTreeTable
        title={title}
        filters={filters}
        setFilters={setFilters}
        items={list.data?.items ?? []}
        loading={list.loading}
        error={list.error}
        retry={list.refresh}
        detail={setDetail}
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
