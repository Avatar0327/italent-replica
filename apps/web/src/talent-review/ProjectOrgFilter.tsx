import { Alert, Button, Checkbox, Input, Modal, Table } from 'antd';
import { useEffect, useState } from 'react';
import { useApiClient } from '../foundation/Session.js';
import type { PageResult } from '../foundation/client.js';
import { display } from './model.js';
import { tr } from './messages.js';
import type { ReviewRecord } from './types.js';

export function ProjectOrgFilter({ value, onChange }: { value: string[]; onChange(value: string[]): void }) {
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [items, setItems] = useState<ReviewRecord[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setItems([]);
    setError(false);
    setLoading(true);
    void (async () => {
      const rows: ReviewRecord[] = [];
      for (let page = 1; page <= 20; page++) {
        const result = await api.request<PageResult<ReviewRecord>>(
          `/api/tenant/org/organizations?page=${page}&pageSize=200`,
          { signal: controller.signal },
        );
        rows.push(...result.items);
        if (result.hasMore === false || (result.hasMore !== true && result.items.length < 200)) {
          if (!controller.signal.aborted) setItems(rows);
          return;
        }
      }
      throw new Error(tr.loadLimit);
    })()
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, open]);
  return (
    <>
      <Button
        size="small"
        type="text"
        onClick={() => {
          setDraft(value);
          setQuery('');
          setOpen(true);
        }}
      >
        {tr.fields.ownerOrgId} ▾
      </Button>
      <Modal
        title={tr.fields.ownerOrgId}
        open={open}
        width={780}
        onCancel={() => setOpen(false)}
        okText={tr.confirm}
        cancelText={tr.cancel}
        okButtonProps={{ disabled: loading || error }}
        onOk={() => {
          onChange(draft);
          setOpen(false);
        }}
      >
        {error && <Alert type="error" message={tr.catalogError} />}
        <div className="review-org-picker">
          <section>
            <h3>{tr.availableOrgs}</h3>
            <Input
              aria-label={tr.search}
              placeholder={tr.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Table
              rowKey="id"
              size="small"
              loading={loading}
              pagination={false}
              dataSource={items.filter((item) => !query || item.name?.includes(query))}
              columns={[{ title: tr.orgName, dataIndex: 'name', render: display }]}
              rowSelection={{
                selectedRowKeys: draft,
                preserveSelectedRowKeys: true,
                onChange: (keys) => setDraft(keys.map(String)),
                hideSelectAll: true,
                getCheckboxProps: (row) => ({ disabled: !draft.includes(row.id) && draft.length >= 100 }),
              }}
            />
          </section>
          <section>
            <h3>{tr.orgSelection(draft.length)}</h3>
            <Button type="link" onClick={() => setDraft([])}>
              {tr.clearSelection}
            </Button>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={draft.map((id) => items.find((row) => row.id === id) ?? { id })}
              columns={[
                { title: tr.orgName, dataIndex: 'name', render: display },
                { title: tr.parentOrg, render: () => tr.missing },
                { title: tr.includeChildren, render: () => <Checkbox disabled title={tr.unverified} /> },
              ]}
              locale={{ emptyText: tr.pickOrgs }}
            />
          </section>
        </div>
      </Modal>
    </>
  );
}
