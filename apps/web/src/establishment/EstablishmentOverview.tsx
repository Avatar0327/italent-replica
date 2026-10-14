import { Alert, Button, Descriptions, Tag } from 'antd';
import { useState } from 'react';
import { ListPage, DetailPage, PageState, DecisionNote, type ListView, type PageResult } from '../foundation/index.js';
import { usePagePermissions, useRemote, RemoteContent, type PageAccess } from '../org/page-support.js';
import { messages as m } from './messages.js';
interface Scheme {
  id: string;
  name?: string;
  [key: string]: unknown;
}
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
export const establishmentObject = 'TenantBase.OrganizationEstablishment';
export function EstablishmentOverview({ view }: { view: ListView }) {
  const permissions = usePagePermissions([establishmentObject]);
  const access = permissions.access(establishmentObject);
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [selected, setSelected] = useState<string>();
  const remote = useRemote<PageResult<Scheme>>(
    access.readable ? `/api/tenant/establishment/schemes?page=${page.page}&pageSize=${page.pageSize}` : null,
  );
  const detail = useRemote<Scheme>(selected ? `/api/tenant/establishment/schemes/${selected}` : null);
  if (permissions.loading) return <PageState kind="loading" />;
  if (permissions.error) return <PageState kind="error" error={permissions.error} />;
  if (!access.readable) return <PageState kind="forbidden" />;
  return (
    <>
      <DecisionNote id="establishment" />
      <ListPage
        title={m.title}
        view={view}
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
        columns={schemeColumns(access, setSelected)}
      />
      <Alert type="info" message={m.hint} showIcon />
      <DetailPage
        open={!!selected}
        onClose={() => setSelected(undefined)}
        summary={<RemoteContent state={detail}>{null}</RemoteContent>}
        title={m.detail}
        tabs={[{ key: 'scheme', label: m.title }]}
        sections={[
          {
            key: 'basic',
            title: m.basic,
            children: (
              <Descriptions
                className="r1-detail-fields"
                column={1}
                items={fields
                  .filter((field) => access.field(field).visible && detail.data?.[field] !== undefined)
                  .map((field) => ({
                    key: field,
                    label: label(field),
                    children: display(field, detail.data?.[field]),
                  }))}
              />
            ),
          },
        ]}
      />
    </>
  );
}

const label = (key: string) => m[key as keyof typeof m] ?? key;
const enums: Record<string, Record<string, string>> = {
  periodType: { annual: m.annual, quarterly: m.quarterly, monthly: m.monthly },
  maintenanceMode: { local: m.local, inclusive: m.inclusive, both: m.both },
  subdivision: { none: m.none, position: m.position },
  unmatchedPolicy: { organization: m.organization, reject: m.reject },
};
function display(field: string, value: unknown) {
  if (field === 'enabled' && typeof value === 'boolean') return value ? m.active : m.inactive;
  const text = String(value ?? m.empty);
  return enums[field]?.[text] ?? text;
}
function schemeColumns(access: PageAccess, onDetail: (id: string) => void) {
  return [
    ...fields
      .filter((field) => access.field(field).visible)
      .map((field) => ({
        key: field,
        title: label(field),
        dataIndex: field,
        render: (value: unknown, row: Scheme) =>
          field === 'name' ? (
            <Button type="link" onClick={() => onDetail(row.id)}>
              {display(field, value)}
            </Button>
          ) : (
            display(field, value)
          ),
      })),
    {
      key: 'actions',
      title: m.actions,
      render: (_: unknown, row: Scheme) => (
        <Button type="link" onClick={() => onDetail(row.id)}>
          {m.viewDetail}
        </Button>
      ),
    },
  ];
}
