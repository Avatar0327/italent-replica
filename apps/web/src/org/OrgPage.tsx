import { Alert, App, Button, Descriptions, Empty, Input, Select, Space, Tag, Tree } from 'antd';
import { useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import {
  DecisionNote,
  DetailPage,
  ListPage,
  PageState,
  TenantDatePicker,
  tenantDate,
  useSession,
  type PageResult,
  type ListView,
} from '../foundation/index.js';
import { EstablishmentOverview, establishmentObject } from '../establishment/EstablishmentOverview.js';
import { OrgEditor, type OrgAction } from './OrgEditor.js';
import { organizationTree, type Dimension, type OrgRow } from './page-model.js';
import { usePagePermissions, useRemote, RemoteContent, type PageAccess } from './page-support.js';
import { pageText as m } from './messages.js';
import { CatalogFilters } from './CatalogFilters.js';
import './workspace.css';
const object = 'TenantBase.Organization';
export function OrgPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const permissions = usePagePermissions([object, establishmentObject]);
  const organizationReadable = permissions.access(object).readable;
  const tabs = [
    ...(organizationReadable ? ['list', 'tree', 'changes'] : []),
    ...(permissions.access(establishmentObject).readable ? ['establishment'] : []),
  ];
  const requested = params.get('tab') ?? (location.pathname.endsWith('/changes') ? 'changes' : tabs[0]);
  const tab = requested ?? 'list';
  const view: ListView = {
    value: tab,
    options: tabs.map((key) => ({ key, label: m[key as 'list'] })),
    onChange: (tab) => setParams({ tab }),
  };
  if (permissions.loading) return <PageState kind="loading" />;
  if (permissions.error) return <PageState kind="error" error={permissions.error} />;
  if (!tabs.includes(tab)) return <PageState kind="forbidden" />;
  return (
    <div className="r1-workspace">
      {tab === 'establishment' ? (
        <EstablishmentOverview view={view} />
      ) : (
        <OrgCatalog key={tab} tab={tab} access={permissions.access(object)} view={view} />
      )}
    </div>
  );
}
function useCatalog() {
  const session = useSession();
  const [date, setDate] = useState(() => tenantDate(new Date(), session.timezone));
  const [dimension, setDimension] = useState<Dimension>('admin');
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [name, setName] = useState('');
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [editor, setEditor] = useState<{ original: OrgRow; action: OrgAction }>();
  const query = new URLSearchParams({
    asOf: date,
    dimension,
    page: String(page.page),
    pageSize: String(page.pageSize),
    includeDisabled: String(includeDisabled),
    ...(name ? { name } : {}),
  });
  const remote = useRemote<PageResult<OrgRow>>(`/api/tenant/org/organizations?${query}`);
  const detail = useRemote<OrgRow>(selected ? `/api/tenant/org/organizations/${selected}?asOf=${date}` : null);
  const reset = () => {
    setPage({ ...page, page: 1 });
    setSelected(undefined);
    setEditor(undefined);
  };
  return {
    date,
    setDate,
    dimension,
    setDimension,
    page,
    setPage,
    name,
    setName,
    includeDisabled,
    setIncludeDisabled,
    selected,
    setSelected,
    editor,
    setEditor,
    remote,
    detail,
    reset,
  };
}
type Catalog = ReturnType<typeof useCatalog>;
const fields = [
  'code',
  'name',
  'fullName',
  'broadType',
  'location',
  'establishedOn',
  'startDate',
  'stopDate',
  'enabled',
];
const label = (field: string) => (field === 'enabled' ? m.status : m[field as 'name']);
function display(field: string, value: unknown) {
  return field === 'enabled' && typeof value === 'boolean' ? (
    <Tag color={value ? 'green' : 'default'}>{value ? m.enabled : m.disabled}</Tag>
  ) : (
    String(value ?? m.missing)
  );
}
function OrgCatalog({ tab, access, view }: { tab: string; access: PageAccess; view: ListView }) {
  const { message } = App.useApp();
  const s = useCatalog();
  return (
    <>
      <DecisionNote id={tab === 'changes' ? 'org-change' : 'org'} />
      <div className={tab === 'tree' ? 'r1-tree-layout' : undefined}>
        {tab === 'tree' && <OrgTree s={s} />}
        <div className="r1-main-panel">
          <OrgList s={s} tab={tab} access={access} view={view} />
        </div>
      </div>
      <OrgDetail s={s} access={access} />
      {s.editor && (
        <OrgEditor
          original={s.editor.original}
          action={s.editor.action}
          date={s.date}
          access={access}
          onClose={() => s.setEditor(undefined)}
          onSaved={() => {
            s.remote.refresh();
            void message.success(m.saved);
          }}
        />
      )}
    </>
  );
}
function OrgTree({ s }: { s: Catalog }) {
  return (
    <aside className="r1-tree-panel" aria-label={m.tree}>
      <h2>{m[s.dimension]}</h2>
      <RemoteContent state={s.remote}>
        {s.remote.data?.items.length ? (
          <Tree
            key={`${s.date}/${s.dimension}/${s.page.page}/${s.name}`}
            defaultExpandAll
            treeData={organizationTree(s.remote.data.items, s.dimension)}
            onSelect={(keys) => s.setSelected(String(keys[0] ?? ''))}
          />
        ) : (
          <Empty description={m.empty} />
        )}
      </RemoteContent>
    </aside>
  );
}
function OrgFilters({ s }: { s: Catalog }) {
  return (
    <Space wrap>
      <Input.Search
        key={s.name}
        defaultValue={s.name}
        aria-label={m.search}
        placeholder={m.search}
        allowClear
        onSearch={(value) => {
          s.setName(value);
          s.reset();
        }}
      />
      <Select
        aria-label={m.hierarchy}
        value={s.dimension}
        onChange={(value) => {
          s.setDimension(value);
          s.reset();
        }}
        options={(['admin', 'business', 'product'] as const).map((value) => ({ value, label: m[value] }))}
      />
      <Select
        aria-label={m.status}
        value={s.includeDisabled ? 'all' : 'enabled'}
        onChange={(value) => {
          s.setIncludeDisabled(value === 'all');
          s.reset();
        }}
        options={[
          { value: 'enabled', label: m.enabled },
          { value: 'all', label: m.all },
        ]}
      />
      <CatalogFilters
        value={{ name: s.name, status: s.includeDisabled ? 'all' : 'enabled' }}
        statuses={[
          { value: 'enabled', label: m.enabled },
          { value: 'all', label: m.all },
        ]}
        clearStatus="all"
        onApply={({ name, status }) => {
          s.setName(name);
          s.setIncludeDisabled(status === 'all');
          s.reset();
        }}
      />
      <span>{m.date}</span>
      <TenantDatePicker
        value={s.date}
        onChange={(value) => {
          if (value) {
            s.setDate(value);
            s.reset();
          }
        }}
      />
    </Space>
  );
}
function OrgList({ s, tab, access, view }: { s: Catalog; tab: string; access: PageAccess; view: ListView }) {
  return (
    <ListPage
      title={m[tab as 'list']}
      view={view}
      rowKey="id"
      page={s.page}
      onPageChange={s.setPage}
      data={
        s.remote.data ? { ...s.remote.data, hasMore: s.remote.data.items.length === s.page.pageSize } : { items: [] }
      }
      loading={s.remote.loading}
      error={s.remote.error}
      retry={s.remote.refresh}
      actions={<Button onClick={s.remote.refresh}>{m.refresh}</Button>}
      filters={
        <>
          <Alert type="info" showIcon message={tab === 'tree' ? m.treeHint : m.changeHint} />
          <OrgFilters s={s} />
        </>
      }
      columns={[
        ...fields
          .filter((field) => access.field(field).visible)
          .map((field) => ({
            key: field,
            title: label(field),
            dataIndex: field,
            render: (value: unknown, row: OrgRow) =>
              field === 'name' ? (
                <Button type="link" onClick={() => s.setSelected(row.id)}>
                  {String(value ?? m.unavailable)}
                </Button>
              ) : (
                display(field, value)
              ),
          })),
        {
          key: 'actions',
          title: m.operation,
          render: (_: unknown, row: OrgRow) => (
            <Button type="link" onClick={() => s.setSelected(row.id)}>
              {m.detail}
            </Button>
          ),
        },
      ]}
    />
  );
}
function OrgDetailActions({ s, access }: { s: Catalog; access: PageAccess }) {
  if (!s.detail.data || !access.can('update')) return null;
  return (
    <>
      {(['edit', 'change', 'disable'] as const)
        .filter((action) => action !== 'edit' || access.field('establishedOn').editable)
        .filter(
          (action) => action !== 'disable' || (access.field('enabled').editable && s.detail.data?.enabled === true),
        )
        .filter((action) => action === 'edit' || access.field('effectiveDate').editable)
        .map((action) => (
          <Button
            key={action}
            danger={action === 'disable'}
            onClick={() => {
              s.setEditor({ original: s.detail.data!, action });
              s.setSelected(undefined);
            }}
          >
            {m[action]}
          </Button>
        ))}
    </>
  );
}
function OrgDetail({ s, access }: { s: Catalog; access: PageAccess }) {
  const { detail } = s;
  return (
    <DetailPage
      open={!!s.selected}
      onClose={() => s.setSelected(undefined)}
      summary={<RemoteContent state={detail}>{null}</RemoteContent>}
      title={access.field('name').visible ? (detail.data?.name ?? m.detail) : m.detail}
      actions={<OrgDetailActions s={s} access={access} />}
      tabs={[{ key: 'organization', label: m.organizationUnit }]}
      sections={[
        {
          key: 'basic',
          title: m.basic,
          children: (
            <Descriptions
              className="r1-detail-fields"
              column={2}
              size="small"
              items={[...fields, 'remarks']
                .filter((field) => access.field(field).visible && detail.data?.[field] !== undefined)
                .map((field) => ({
                  key: field,
                  label: label(field),
                  children: display(field, detail.data?.[field]),
                }))}
            />
          ),
        },
        ...(access.field('parents').visible
          ? [
              {
                key: 'parents',
                title: m.hierarchy,
                children: (
                  <Descriptions
                    className="r1-detail-fields"
                    column={1}
                    items={(['admin', 'business', 'product'] as const)
                      .filter((key) => detail.data?.parents?.[key])
                      .map((key) => ({
                        key,
                        label: m[key],
                        children: detail.data?.parents?.[key]?.parentId ?? m.missing,
                      }))}
                  />
                ),
              },
            ]
          : []),
      ].filter(() => !!detail.data)}
    />
  );
}
