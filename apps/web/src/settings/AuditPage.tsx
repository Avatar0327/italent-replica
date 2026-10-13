import { Button, Form, Input, Space } from 'antd';
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
    setPage({ page: 1, pageSize: 15 });
    setCursors(['']);
    list.refresh();
  };
  const instant = (value: string) =>
    timezone
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
          if (next.page > page.page) {
            if (!list.data?.nextCursor) return;
            setCursors([...cursors.slice(0, page.page), list.data.nextCursor]);
          }
          setPage(next);
        }}
        actions={<Button onClick={refresh}>{m.refresh}</Button>}
        filters={
          <Space>
            <span>
              {m.occurredAt}: {list.data?.window?.from ?? m.empty} ~ {list.data?.window?.to ?? m.empty}
            </span>
            <Button
              type="link"
              onClick={() => {
                setFilterOpen(true);
              }}
            >
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
            setFilters(values);
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
      onClear={() => form.resetFields()}
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
      render: (value: string, row: Audit) => (
        <Button type="link" onClick={() => setDetail(row.id)}>
          {value ?? m.detail}
        </Button>
      ),
    },
    { title: m.operator, render: (_: unknown, row: Audit) => row.operator.name },
    { title: m.occurredAt, dataIndex: 'occurredAt', render: instant },
    { title: m.operation, dataIndex: 'operationLabel' },
    { title: m.object, dataIndex: 'objectLabel' },
    { title: m.content, dataIndex: 'content', width: 320 },
    { title: m.sourceAction, dataIndex: 'sourceAction' },
  ];
}
