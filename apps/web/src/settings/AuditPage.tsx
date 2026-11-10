import { Button, Form, Input, Select, Space } from 'antd';
import { useState } from 'react';
import { FilterDrawer } from '../foundation/FilterDrawer.js';
import { useSession } from '../foundation/Session.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { ListPage } from '../foundation/templates.js';
import { type Audit } from './model.js';
import { Facts, RemoteDetail, valueText } from './parts.js';
import { useResource } from './useResource.js';
import { m } from './messages.js';
interface AuditPageResult {
  items: Audit[];
  nextCursor: string | null;
  apps: string[];
  window: { from: string; to: string };
}
const auditBase = '/api/tenant/audit/data-changes';
export function AuditPage() {
  const { timezone } = useSession();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [cursors, setCursors] = useState<string[]>(['']);
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [detail, setDetail] = useState<string>();
  const query = new URLSearchParams({ ...filters, limit: String(page.pageSize) });
  const cursor = cursors[page.page - 1];
  if (cursor) query.set('cursor', cursor);
  const list = useResource<AuditPageResult>(`${auditBase}?${query}`);
  const refresh = () => {
    setPage((current) => ({ ...current, page: 1 }));
    setCursors(['']);
    list.refresh();
  };
  const instant = (value: string) => auditInstant(value, timezone);
  return (
    <>
      <ListPage
        title={m.audit}
        rowKey="id"
        page={page}
        loading={list.loading}
        error={list.error}
        retry={list.refresh}
        data={{ items: list.data?.items ?? [], hasMore: !!list.data?.nextCursor }}
        onPageChange={(next) => {
          if (next.pageSize !== page.pageSize) {
            setCursors(['']);
          } else if (next.page > page.page) {
            if (!list.data?.nextCursor) return;
            setCursors([...cursors.slice(0, page.page), list.data.nextCursor]);
          }
          setPage(next);
        }}
        actions={<Button onClick={refresh}>{m.refresh}</Button>}
        filters={
          <Space wrap>
            <Select
              aria-label={m.auditApp}
              placeholder={m.auditApp}
              className="settings-app-filter"
              allowClear
              value={filters.app}
              options={(list.data?.apps ?? []).map((app) => ({ value: app, label: app }))}
              onChange={(app: string | undefined) => {
                const { app: _previous, ...rest } = filters;
                setFilters(app ? { ...rest, app } : rest);
                refresh();
              }}
            />
            <span>
              {m.occurredAt}: {list.data?.window?.from ?? m.empty} ~ {list.data?.window?.to ?? m.empty}
            </span>
            <Button type="link" onClick={() => setFilterOpen(true)}>
              {m.advanced}
            </Button>
          </Space>
        }
        columns={auditColumns(instant, setDetail)}
      />
      {filterOpen && (
        <AuditFilter
          filters={filters}
          close={() => setFilterOpen(false)}
          setFilters={(values) => {
            setFilters({ ...values, ...(filters.app ? { app: filters.app } : {}) });
            refresh();
          }}
        />
      )}
      {detail && <AuditDetails detail={detail} instant={instant} close={() => setDetail(undefined)} />}
    </>
  );
}

function AuditFilter({
  filters,
  close,
  setFilters,
}: {
  filters: Record<string, string>;
  close(): void;
  setFilters(values: Record<string, string>): void;
}) {
  const [form] = Form.useForm();
  return (
    <FilterDrawer
      open
      onClose={() => close()}
      onClear={() =>
        form.setFieldsValue({
          from: undefined,
          to: undefined,
          objectType: undefined,
          field: undefined,
          traceId: undefined,
        })
      }
      onApply={() => {
        void form
          .validateFields()
          .then((values: Record<string, string>) => {
            setFilters(Object.fromEntries(Object.entries(values).filter(([, value]) => !!value)));
            close();
          })
          .catch(() => {});
      }}
    >
      <Form form={form} layout="vertical" initialValues={filters}>
        <Form.Item name="from" label={m.from}>
          <TenantDatePicker />
        </Form.Item>
        <Form.Item
          name="to"
          label={m.to}
          dependencies={['from']}
          rules={[
            {
              validator: async (_, value: string) => {
                if (value && form.getFieldValue('from') && value < form.getFieldValue('from'))
                  throw new Error(m.invalid);
              },
            },
          ]}
        >
          <TenantDatePicker />
        </Form.Item>
        <Form.Item
          name="traceId"
          label={m.traceId}
          rules={[{ pattern: /^[A-Za-z0-9_.:-]{1,128}$/, message: m.invalidTraceId }]}
        >
          <Input maxLength={128} />
        </Form.Item>
        <Form.Item name="objectType" label={m.object}>
          <Input />
        </Form.Item>
        <Form.Item name="field" label={m.field}>
          <Input />
        </Form.Item>
      </Form>
    </FilterDrawer>
  );
}

function AuditDetails({ detail, close, instant }: { detail: string; close(): void; instant(value: string): string }) {
  return (
    <RemoteDetail<Audit> path={`${auditBase}/${detail}`} title={m.audit} close={close}>
      {(row) => (
        <>
          <Facts
            items={[
              [m.operator, row.operator.name],
              [m.occurredAt, instant(row.occurredAt)],
              [m.object, row.objectLabel],
              [m.objectId, row.objectId],
              [m.sourceAction, row.sourceAction],
              [m.traceId, row.traceId],
            ]}
          />
          <h3>{m.content}</h3>
          <p>{row.content}</p>
          {row.snapshot != null && (
            <>
              <h3>{m.snapshot}</h3>
              <pre>{valueText(row.snapshot)}</pre>
            </>
          )}
        </>
      )}
    </RemoteDetail>
  );
}

function auditColumns(instant: (value: string) => string, setDetail: (id: string) => void) {
  return [
    {
      title: m.objectId,
      dataIndex: 'objectId',
      width: 128,
      render: (value: string | null, row: Audit) =>
        value === null || value === undefined ? (
          m.empty
        ) : (
          <Button type="link" onClick={() => setDetail(row.id)}>
            {value}
          </Button>
        ),
    },
    { title: m.operator, width: 118, render: (_: unknown, row: Audit) => row.operator.name },
    { title: m.occurredAt, dataIndex: 'occurredAt', width: 146, render: instant },
    { title: m.auditOperation, dataIndex: 'operationLabel', width: 128 },
    { title: m.auditApp, dataIndex: 'app', width: 128 },
    { title: m.object, dataIndex: 'objectLabel', width: 128 },
    { title: m.content, dataIndex: 'content', width: 128, ellipsis: { showTitle: false } },
    ...[
      ['sourceAction', m.sourceAction],
      ['sourcePageType', m.sourcePageType],
      ['sourcePage', m.sourcePage],
      ['terminal', m.terminal],
      ['clientVersion', m.clientVersion],
      ['ip', m.ip],
      ['traceId', m.traceId],
    ].map(([dataIndex, title]) => ({
      title,
      dataIndex,
      width: 128,
      ellipsis: { showTitle: false },
      render: (value: string | null) => value ?? m.empty,
    })),
    { key: 'columns', title: '', width: 24, render: () => <span aria-hidden>⚙</span> },
  ];
}

function auditInstant(value: string, timezone?: string) {
  return timezone
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : value;
}
