import { Alert, App, Button, Descriptions, Dropdown, Empty, Input, Select, Space, Tag, Tree } from 'antd';
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
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { OrgCreate } from './OrgCreate.js';
import { OrgEditor } from './OrgEditor.js';
import { PersonName } from './PersonFields.js';
import {
  orgActions,
  orgCatalogQuery,
  orgCreatable,
  orgDetailFields,
  orgLabel,
  orgListFields,
  orgObject,
  organizationTree,
  type Dimension,
  type OrgAction,
  type OrgRow,
} from './page-model.js';
import { usePagePermissions, useRemote, RemoteContent, type PageAccess } from './page-support.js';
import { detailText, pageText as m, text } from './messages.js';
import { CatalogFilters } from './CatalogFilters.js';
import './workspace.css';
export function OrgPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const permissions = usePagePermissions([orgObject, establishmentObject]);
  const organizationReadable = permissions.access(orgObject).readable;
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
    <FormCommands>
      <div className="r1-workspace">
        {tab === 'establishment' ? (
          <EstablishmentOverview view={view} />
        ) : (
          <OrgCatalog key={tab} tab={tab} access={permissions.access(orgObject)} view={view} />
        )}
      </div>
    </FormCommands>
  );
}
function useCatalog(access: PageAccess) {
  const session = useSession();
  const [date, setDate] = useState(() => tenantDate(new Date(), session.timezone));
  const [dimension, setDimension] = useState<Dimension>('admin');
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [name, setName] = useState('');
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [editor, setEditor] = useState<{ original: OrgRow; action: OrgAction }>();
  const [creating, setCreating] = useState<{ parentId?: string }>();
  const filters = { asOf: date, dimension, ...page, includeDisabled, name };
  const query = orgCatalogQuery(filters, access.field('name').visible);
  const remote = useRemote<PageResult<OrgRow>>(`/api/tenant/org/organizations?${query}`);
  const detail = useRemote<OrgRow>(selected ? `/api/tenant/org/organizations/${selected}?asOf=${date}` : null);
  const reset = () => {
    setPage({ ...page, page: 1 });
    setSelected(undefined);
    setEditor(undefined);
    setCreating(undefined);
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
    creating,
    setCreating,
    remote,
    detail,
    reset,
  };
}
type Catalog = ReturnType<typeof useCatalog>;
function display(field: string, value: unknown) {
  return field === 'enabled' && typeof value === 'boolean' ? (
    <Tag color={value ? 'green' : 'default'}>{value ? m.enabled : m.disabled}</Tag>
  ) : (
    String(value ?? m.missing)
  );
}
function OrgCatalog({ tab, access, view }: { tab: string; access: PageAccess; view: ListView }) {
  const { message } = App.useApp();
  const s = useCatalog(access);
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
      {s.creating && (
        <OrgCreate
          parentId={s.creating.parentId}
          date={s.date}
          access={access}
          onClose={() => s.setCreating(undefined)}
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
function OrgFilters({ s, access }: { s: Catalog; access: PageAccess }) {
  const nameVisible = access.field('name').visible;
  return (
    <Space wrap>
      {nameVisible && (
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
      )}
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
        showName={nameVisible}
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
      actions={<OrgListActions s={s} access={access} />}
      filters={
        <>
          <Alert type="info" showIcon closable message={tab === 'tree' ? m.treeHint : m.changeHint} />
          <OrgFilters s={s} access={access} />
        </>
      }
      columns={[
        ...orgListFields(access).map((field) => ({
          key: field,
          title: orgLabel(field, 'list'),
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
        ...(access.can('update') || orgCreatable(access) || !access.field('name').visible
          ? [
              {
                key: 'actions',
                title: m.operation,
                render: (_: unknown, row: OrgRow) => <OrgRowActions s={s} access={access} row={row} />,
              },
            ]
          : []),
      ]}
    />
  );
}
// 导入拆到后续 PR（见 PR 说明）；新建与新建下级共用 orgCreatable 判定。
function OrgListActions({ s, access }: { s: Catalog; access: PageAccess }) {
  return (
    <>
      <Button onClick={s.remote.refresh}>{m.refresh}</Button>
      {orgCreatable(access) && (
        <Button type="primary" onClick={() => openCreate(s)}>
          {m.create}
        </Button>
      )}
    </>
  );
}
function openCreate(s: Catalog, parentId?: string) {
  s.setCreating({ parentId });
  s.setSelected(undefined);
}
function openEditor(s: Catalog, original: OrgRow, action: OrgAction) {
  s.setEditor({ original, action });
  s.setSelected(undefined);
}
// 原站行内为「编辑」与下拉；变更、停用收进「更多」，与详情按钮共用 orgActions 判定。
// 名称列被字段权限隐藏时没有入口打开详情，保留「详情」兜底（AC-FE-R1a-19）。
function OrgRowActions({ s, access, row }: { s: Catalog; access: PageAccess; row: OrgRow }) {
  const actions = orgActions(access, row);
  const more = actions.filter((action) => action !== 'edit');
  return (
    <Space size={4}>
      {!access.field('name').visible && (
        <Button type="link" onClick={() => s.setSelected(row.id)}>
          {m.detail}
        </Button>
      )}
      {actions.includes('edit') && (
        <Button type="link" onClick={() => openEditor(s, row, 'edit')}>
          {m.edit}
        </Button>
      )}
      {orgCreatable(access) && (
        <Button type="link" onClick={() => openCreate(s, row.id)}>
          {m.createChild}
        </Button>
      )}
      {more.length > 0 && (
        <Dropdown
          trigger={['click']}
          menu={{
            items: more.map((action) => ({ key: action, label: m[action] })),
            onClick: ({ key }) => openEditor(s, row, key as OrgAction),
          }}
        >
          <Button type="link">{m.more}</Button>
        </Dropdown>
      )}
    </Space>
  );
}
function OrgDetailActions({ s, access }: { s: Catalog; access: PageAccess }) {
  const original = s.detail.data;
  if (!original) return null;
  return (
    <>
      {orgCreatable(access) && <Button onClick={() => openCreate(s, original.id)}>{m.createChild}</Button>}
      {orgActions(access, original).map((action) => (
        <Button
          key={action}
          type="primary"
          ghost={action === 'disable'}
          onClick={() => openEditor(s, original, action)}
        >
          {m[action]}
        </Button>
      ))}
    </>
  );
}
/** 上级只存 ID；名称按当前权限读取上级详情，读不到（范围外 / 已失效）时明确提示，不补写。 */
function OrgParentName({ id, date }: { id: string; date: string }) {
  const parent = useRemote<OrgRow>(`/api/tenant/org/organizations/${id}?asOf=${date}`);
  if (parent.error) return <>{text.hiddenParent}</>;
  if (!parent.data) return <>{m.missing}</>;
  return <>{parent.data.name ?? m.unavailable}</>;
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
              items={orgDetailFields(access)
                .filter((field) => detail.data?.[field] !== undefined)
                .map((field) => ({
                  key: field,
                  label: orgLabel(field, 'detail'),
                  children: detailValue(field, detail.data?.[field]),
                }))}
            />
          ),
        },
        ...(access.field('parents').visible
          ? [
              {
                key: 'parents',
                title: m.parent,
                children: (
                  <Descriptions
                    className="r1-detail-fields"
                    column={1}
                    items={(['admin', 'business', 'product'] as const)
                      .filter((key) => detail.data?.parents?.[key])
                      .map((key) => ({
                        key,
                        label: detailText[key],
                        children: parentName(detail.data?.parents?.[key]?.parentId, s.date),
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
function detailValue(field: string, value: unknown) {
  if (field === 'personInChargeId' && typeof value === 'string' && value) return <PersonName id={value} />;
  return display(field, value);
}
function parentName(id: string | null | undefined, date: string) {
  return id ? <OrgParentName id={id} date={date} /> : m.missing;
}
