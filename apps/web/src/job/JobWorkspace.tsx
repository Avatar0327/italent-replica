import { Button, Descriptions, Input, Select, Space, Tag, App } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
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
import { usePagePermissions, useRemote, RemoteContent, type PageAccess } from '../org/page-support.js';
import { useSequenceSelection } from './SequenceSync.js';
import { JobEditor, JobHints, ReferenceSelect } from './JobEditor.js';
import { ReferenceName } from './ReferenceName.js';
import {
  jobCatalogQuery,
  jobDetailSections,
  jobInitialValues,
  jobKinds,
  jobLabel,
  jobListFields,
  jobObjects,
  referenceKind,
  type JobKind,
  type JobRow,
} from './page-model.js';
import { pageText as m } from './messages.js';
import { CatalogFilters } from '../org/CatalogFilters.js';
import '../org/workspace.css';

export function JobWorkspace() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('kind') as JobKind;
  const permissions = usePagePermissions(Object.values(jobObjects));
  if (permissions.loading) return <PageState kind="loading" />;
  if (permissions.error) return <PageState kind="error" error={permissions.error} />;
  const allowed = jobKinds.filter((kind) => permissions.access(jobObjects[kind]).readable);
  if (!allowed.length) return <PageState kind="forbidden" />;
  const fallback = allowed.includes('posts') ? 'posts' : allowed[0]!;
  const kind = allowed.includes(requested) ? requested : fallback;
  return (
    <div className="r1-workspace">
      <DecisionNote id="job" />
      <JobCatalog
        key={kind}
        kind={kind}
        access={permissions.access(jobObjects[kind])}
        view={{
          value: kind,
          options: allowed.map((key) => ({ key, label: m[key] })),
          onChange: (kind) => setParams({ kind }),
        }}
      />
    </div>
  );
}
function useCatalog(kind: JobKind) {
  const session = useSession();
  const [date, setDate] = useState(() => tenantDate(new Date(), session.timezone));
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState('true');
  const [orgId, setOrgId] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [editor, setEditor] = useState<{ original?: JobRow; today: string }>();
  const query = jobCatalogQuery(kind, { asOf: date, ...page, name, enabled, orgId });
  const remote = useRemote<PageResult<JobRow> & { today: string }>(`/api/tenant/job/${kind}?${query}`);
  const detail = useRemote<JobRow>(selected ? `/api/tenant/job/${kind}/${selected}?asOf=${date}` : null);
  const reset = () => {
    setPage({ ...page, page: 1 });
    setSelected(undefined);
    setEditor(undefined);
  };
  return {
    kind,
    date,
    setDate,
    page,
    setPage,
    name,
    setName,
    enabled,
    setEnabled,
    orgId,
    setOrgId,
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
function renderValue(field: string, value: unknown) {
  if (field === 'enabled' && typeof value === 'boolean')
    return <Tag color={value ? 'green' : 'default'}>{value ? m.active : m.inactive}</Tag>;
  if (typeof value === 'boolean') return value ? m.yes : m.no;
  return String(value ?? m.missing);
}
function renderDetailValue(s: Catalog, field: string, value: unknown) {
  const target = referenceKind(s.kind, field);
  if (target && typeof value === 'string' && value) return <ReferenceName kind={target} id={value} date={s.date} />;
  return renderValue(field, value);
}
function JobFilters({ s, access }: { s: Catalog; access: PageAccess }) {
  return (
    <>
      <JobHints kind={s.kind} />
      <Space wrap>
        {s.kind === 'positions' && access.field('orgId').visible && (
          <ReferenceSelect
            kind="org"
            date={s.date}
            value={s.orgId}
            placeholder={m.orgFilter}
            onChange={(value) => {
              s.setOrgId(value ?? undefined);
              s.reset();
            }}
          />
        )}
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
          aria-label={m.enabled}
          value={s.enabled}
          onChange={(value) => {
            s.setEnabled(value);
            s.reset();
          }}
          options={[
            { value: 'true', label: m.active },
            { value: 'false', label: m.inactive },
            { value: '', label: m.all },
          ]}
        />
        <CatalogFilters
          value={{ name: s.name, status: s.enabled }}
          statuses={[
            { value: 'true', label: m.active },
            { value: 'false', label: m.inactive },
            { value: '', label: m.all },
          ]}
          clearStatus=""
          onApply={({ name, status }) => {
            s.setName(name);
            s.setEnabled(status);
            s.reset();
          }}
        />
        <span>{m.startDate}</span>
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
    </>
  );
}
function JobCatalog({ kind, access, view }: { kind: JobKind; access: PageAccess; view: ListView }) {
  const { message } = App.useApp();
  const s = useCatalog(kind);
  const selection = useSequenceSelection(kind, s.remote.data, access, s.remote.refresh);
  const columns = jobColumns(kind, access, s.setSelected);
  return (
    <>
      <ListPage
        title={m[kind]}
        view={view}
        rowKey="id"
        selection={selection}
        page={s.page}
        onPageChange={s.setPage}
        data={
          s.remote.data ? { ...s.remote.data, hasMore: s.remote.data.items.length === s.page.pageSize } : { items: [] }
        }
        loading={s.remote.loading}
        error={s.remote.error}
        retry={s.remote.refresh}
        filters={<JobFilters s={s} access={access} />}
        actions={
          <>
            <Button onClick={s.remote.refresh}>{m.refresh}</Button>
            {access.can('create', 'list') && (
              <Button
                type="primary"
                disabled={s.remote.loading || !!s.remote.error}
                onClick={() => s.remote.data && s.setEditor({ today: s.remote.data.today })}
              >
                {m.create}
              </Button>
            )}
          </>
        }
        columns={columns}
      />
      <JobDetail s={s} access={access} />
      {s.editor && (
        <JobEditor
          kind={kind}
          original={s.editor.original}
          date={s.date}
          today={s.editor.today}
          access={access}
          onClose={() => {
            s.setEditor(undefined);
            s.remote.refresh();
          }}
          onSaved={() => {
            s.remote.refresh();
            void message.success(m.saved);
          }}
        />
      )}
    </>
  );
}
function JobDetail({ s, access }: { s: Catalog; access: PageAccess }) {
  const { detail, kind } = s;
  const values = jobInitialValues(detail.data);
  const sections = detail.data ? jobDetailSections(kind, access, values) : [];
  return (
    <DetailPage
      open={!!s.selected}
      onClose={() => s.setSelected(undefined)}
      summary={<RemoteContent state={detail}>{null}</RemoteContent>}
      title={access.field('name').visible ? (detail.data?.name ?? m.detail) : m.detail}
      actions={
        detail.data &&
        access.can('update') && (
          <Button
            type="primary"
            onClick={() => {
              s.setEditor({ original: detail.data, today: s.remote.data?.today ?? s.date });
              s.setSelected(undefined);
            }}
          >
            {m.edit}
          </Button>
        )
      }
      tabs={[{ key: 'record', label: m[kind] }]}
      sections={sections.map((section) => ({
        key: section.key,
        title: m[section.key as 'basic'],
        children: (
          <Descriptions
            className="r1-detail-fields"
            column={2}
            layout="vertical"
            size="small"
            items={section.fields.map((field) => ({
              key: field,
              label: jobLabel(kind, field),
              children: renderDetailValue(s, field, values[field]),
            }))}
          />
        ),
      }))}
    />
  );
}

function jobColumns(kind: JobKind, access: PageAccess, select: (id: string) => void) {
  // 原站列表无操作列，点名称打开详情抽屉；名称被字段权限隐藏时保留「详情」兜底（AC-FE-R1a-19）。
  const fallback = access.field('name').visible
    ? []
    : [
        {
          key: 'actions',
          title: m.operation,
          render: (_: unknown, row: JobRow) => (
            <Button type="link" onClick={() => select(row.id)}>
              {m.detail}
            </Button>
          ),
        },
      ];
  return [...jobListFields(kind, access).map(listColumn(kind, select)), ...fallback];
}
function listColumn(kind: JobKind, select: (id: string) => void) {
  return (field: string) => ({
    key: field,
    title: jobLabel(kind, field),
    dataIndex: field,
    render: (value: unknown, row: JobRow) =>
      field === 'name' ? (
        <Button type="link" onClick={() => select(row.id)}>
          {String(value ?? m.missing)}
        </Button>
      ) : (
        renderValue(field, value)
      ),
  });
}
