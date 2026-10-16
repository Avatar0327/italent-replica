import { Alert, App, Button, Dropdown, Empty, Input, Select, Space, Tree } from 'antd';
import { useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import {
  DecisionNote,
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
import { OrgDetail, orgValue } from './OrgDetail.js';
import { OrgEditor } from './OrgEditor.js';
import { OrgImport, OrgImportResults } from './OrgImport.js';
import { OrgColumnGear, OrgColumnSettings } from './ColumnSettings.js';
import { orgColumnOptions, restoreOrgColumns, visibleOrgColumns } from './columns.js';
import type { OrgImportResult } from './import-model.js';
import {
  orgActions,
  orgCatalogQuery,
  orgCreatable,
  orgImportable,
  orgLabel,
  orgObject,
  organizationTree,
  type Dimension,
  type OrgAction,
  type OrgRow,
} from './page-model.js';
import { usePagePermissions, useRemote, RemoteContent, type PageAccess } from './page-support.js';
import { importText, pageText as m } from './messages.js';
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
  // 列设置只在本次页面会话中生效（与人员列表同一口径，原站另有服务端保存，列入缺口）。
  const [columns, setColumns] = useState(restoreOrgColumns);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<OrgImportResult[]>();
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
    columns,
    setColumns,
    columnsOpen,
    setColumnsOpen,
    importing,
    setImporting,
    imported,
    setImported,
    remote,
    detail,
    reset,
  };
}
type Catalog = ReturnType<typeof useCatalog>;
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
      <OrgDetail
        selected={s.selected}
        date={s.date}
        detail={s.detail}
        access={access}
        onClose={() => s.setSelected(undefined)}
        onCreate={(parentId) => openCreate(s, parentId)}
        onEdit={(original, action) => openEditor(s, original, action)}
      />
      <CatalogDialogs s={s} access={access} />
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
/** 列设置、导入与导入结果弹窗；导入成功后刷新列表并展示逐行回执。 */
function CatalogDialogs({ s, access }: { s: Catalog; access: PageAccess }) {
  const { message } = App.useApp();
  return (
    <>
      {s.columnsOpen && (
        <OrgColumnSettings
          value={s.columns}
          allowed={orgColumnOptions(access)}
          onApply={s.setColumns}
          onClose={() => s.setColumnsOpen(false)}
        />
      )}
      {s.importing && (
        <OrgImport
          access={access}
          onClose={() => s.setImporting(false)}
          onImported={(results) => {
            s.setImported(results);
            s.remote.refresh();
            void message.success(importText.saved);
          }}
        />
      )}
      {s.imported && <OrgImportResults results={s.imported} onClose={() => s.setImported(undefined)} />}
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
// 原站「启用的组织」顶部提示（01）；架构图与变更页签保留各自的操作提示。
const hints = { list: m.listHint, tree: m.treeHint, changes: m.changeHint };
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
          <Alert type="info" showIcon closable message={hints[tab as keyof typeof hints]} />
          <OrgFilters s={s} access={access} />
        </>
      }
      columns={[
        ...visibleOrgColumns(s.columns, orgColumnOptions(access)).map((field) => ({
          key: field,
          title: orgLabel(field, 'list'),
          dataIndex: field,
          render: (value: unknown, row: OrgRow) =>
            field === 'name' ? (
              <Button type="link" onClick={() => s.setSelected(row.id)}>
                {String(value ?? m.unavailable)}
              </Button>
            ) : (
              orgValue(field, value)
            ),
        })),
        {
          key: 'actions',
          // 原站操作列表头带齿轮，打开「设置显示字段」（01、B2_03）。
          title: (
            <Space size={4}>
              {m.operation}
              <OrgColumnGear onOpen={() => s.setColumnsOpen(true)} />
            </Space>
          ),
          render: (_: unknown, row: OrgRow) => <OrgRowActions s={s} access={access} row={row} />,
        },
      ]}
    />
  );
}
/** 原站列表工具栏：新建与「更多操作▾」，导入在「更多操作」里（01；下拉其余项未取证，未验证）。 */
function OrgListActions({ s, access }: { s: Catalog; access: PageAccess }) {
  const importable = orgImportable(access);
  return (
    <>
      {orgCreatable(access) && (
        <Button type="primary" onClick={() => openCreate(s)}>
          {m.create}
        </Button>
      )}
      {importable && (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [{ key: 'import', label: m.import }],
            onClick: () => s.setImporting(true),
          }}
        >
          <Button>{m.moreActions}</Button>
        </Dropdown>
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
// 原站行内依次为「新建下级」「编辑」与下拉（01）；变更、停用收进下拉，与详情按钮共用 orgActions 判定。
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
      {orgCreatable(access) && (
        <Button type="link" onClick={() => openCreate(s, row.id)}>
          {m.createChild}
        </Button>
      )}
      {actions.includes('edit') && (
        <Button type="link" onClick={() => openEditor(s, row, 'edit')}>
          {m.edit}
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
