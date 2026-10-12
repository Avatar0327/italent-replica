import { Alert, Button, Descriptions, Drawer, Tag } from 'antd';
import { useState } from 'react';
import { ListPage, DetailPage, PageState, DecisionNote, type PageResult } from '../foundation/index.js';
import { usePagePermissions, useRemote, RemoteContent } from '../org/page-support.js';
import { messages as m } from './messages.js';
interface Scheme {
  id: string;
  name?: string;
  [key: string]: unknown;
}
export const establishmentObject = 'TenantBase.OrganizationEstablishment';
export function EstablishmentOverview() {
  const permissions = usePagePermissions([establishmentObject]);
  const access = permissions.access(establishmentObject);
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [selected, setSelected] = useState<string>();
  const remote = useRemote<PageResult<Scheme>>(
    access.readable ? `/api/tenant/establishment/schemes?page=${page.page}&pageSize=${page.pageSize}` : null,
  );
  const detail = useRemote<Scheme>(selected ? `/api/tenant/establishment/schemes/${selected}` : null);
  const fields = [
    'name',
    'code',
    'periodType',
    'maintenanceMode',
    'startMonth',
    'subdivision',
    'unmatchedPolicy',
    'enabled',
    'startDate',
    'stopDate',
  ];
  const label = (key: string) => m[key as keyof typeof m] ?? key;
  const display = (value: unknown) => {
    if (typeof value === 'boolean') return value ? m.active : m.inactive;
    return label(String(value ?? m.empty));
  };
  if (permissions.loading) return <PageState kind="loading" />;
  if (permissions.error) return <PageState kind="error" error={permissions.error} />;
  if (!access.readable) return <PageState kind="forbidden" />;
  return (
    <>
      <DecisionNote id="establishment" />
      <ListPage
        title={m.title}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        data={remote.data ? { ...remote.data, hasMore: remote.data.items.length === page.pageSize } : { items: [] }}
        loading={remote.loading}
        error={remote.error}
        retry={remote.refresh}
        actions={
          <>
            <Tag>{m.readOnly}</Tag>
            <Button onClick={remote.refresh}>{m.refresh}</Button>
          </>
        }
        columns={fields
          .filter((field) => access.field(field).visible)
          .map((field) => ({
            key: field,
            title: label(field),
            dataIndex: field,
            render: (value: unknown, row: Scheme) =>
              field === 'name' ? (
                <Button type="link" onClick={() => setSelected(row.id)}>
                  {display(value)}
                </Button>
              ) : (
                display(value)
              ),
          }))}
      />
      <Alert type="info" message={m.hint} showIcon />
      <Drawer
        rootClassName="r1-detail"
        open={!!selected}
        onClose={() => setSelected(undefined)}
        width={640}
        title={m.detail}
      >
        <RemoteContent state={detail}>
          <DetailPage
            title={m.detail}
            tabs={[{ key: 'scheme', label: m.title }]}
            sections={[
              {
                key: 'basic',
                title: m.basic,
                children: (
                  <Descriptions
                    column={1}
                    items={fields
                      .filter((field) => access.field(field).visible && detail.data?.[field] !== undefined)
                      .map((field) => ({ key: field, label: label(field), children: display(detail.data?.[field]) }))}
                  />
                ),
              },
            ]}
          />
        </RemoteContent>
      </Drawer>
    </>
  );
}
