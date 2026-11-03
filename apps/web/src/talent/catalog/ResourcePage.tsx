import { Alert, Button, Input, Space, Select, Tooltip, Checkbox } from 'antd';
import { useState } from 'react';
import { DecisionNote } from '../../foundation/DecisionNote.js';
import { PageState } from '../../foundation/PageState.js';
import { ListPage } from '../../foundation/templates.js';
import { canButton, fieldAccess, type ObjectPermission } from '../../foundation/permission-model.js';
import { useApiClient, useSession } from '../../foundation/Session.js';
import { listResource, resourcePath } from './api.js';
import { useRemote, useReferenceNames } from './hooks.js';
import { ResourceDetail, display } from './ResourceDetail.js';
import { ResourceForm } from './ResourceForm.js';
import type { Resource, Row } from './types.js';
import { m } from './messages.js';
import { CatalogTree } from './CatalogTree.js';
import { alignment, fullPageDetail } from './alignment.js';

function useResourceState(resource: Resource, permission: ObjectPermission) {
  const api = useApiClient();
  const session = useSession();
  const [scope, setScope] = useState('');
  const defaultEnabled =
    resource.module === 'qualification' &&
    ['categories', 'levels', 'targets'].includes(resource.key) &&
    fieldAccess(permission, 'enabled').visible;
  const scopeQuery = scope && fieldAccess(permission, 'classId').visible ? `&classId=${encodeURIComponent(scope)}` : '';
  const query = `${defaultEnabled ? '&enabled=true' : ''}${scopeQuery}`;
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [generation, refresh] = useState(0);
  const names = useReferenceNames(resource, generation, permission);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<string>();
  const [editor, setEditor] = useState<{ original: Row | null }>();
  const [editError, setEditError] = useState<unknown>();
  const [editing, setEditing] = useState(false);
  const list = useRemote(`list:${resource.object}:${page.page}:${page.pageSize}:${generation}:${query}`, (client) =>
    listResource(client, resource, page, query),
  );
  const reload = () => {
    setEditError(undefined);
    refresh((value) => value + 1);
  };
  const edit = async (id: string) => {
    setEditing(true);
    setEditError(undefined);
    try {
      setEditor({ original: await api.request<Row>(`${resourcePath(resource)}/${id}`) });
    } catch (error) {
      setEditError(error);
    } finally {
      setEditing(false);
    }
  };
  return {
    page,
    setPage,
    scope,
    setScope,
    defaultEnabled,
    timezone: session.timezone,
    search,
    setSearch,
    view,
    setView,
    editor,
    setEditor,
    editError,
    editing,
    list,
    reload,
    edit,
    names,
  };
}
type State = ReturnType<typeof useResourceState>;
function resourceColumns(resource: Resource, permission: ObjectPermission, state: State) {
  const layout = alignment(resource);
  const columns = resource.columns
    .filter((key) => fieldAccess(permission, layout[key]?.permission ?? key).visible)
    .map((key) => ({
      key,
      dataIndex: key,
      title: layout[key]?.label ?? resource.fields.find((field) => field.key === key)?.label ?? key,
      width: layout[key]?.width,
      render: (value: unknown, row: Row) =>
        key === 'name' ? (
          <Button type="link" className="catalog-name" onClick={() => state.setView(row.id)}>
            {display(value)}
          </Button>
        ) : resource.key === 'standards' && key === 'classId' ? (
          (state.names.data?.get(`class:${row.categoryId}`) ?? m.unknown)
        ) : layout[key]?.unavailable || key === 'createdBy' || key === 'jobLinks' ? (
          m.unknown
        ) : key === 'createdAt' ? (
          timestamp(value, state.timezone)
        ) : key === 'jobLinkType' ? (
          display(m.jobTypes[value as keyof typeof m.jobTypes])
        ) : (
          display(typeof value === 'string' ? (state.names.data?.get(value) ?? value) : value)
        ),
    }));
  return [
    ...((resource.module === 'talent' && ['criteria', 'libraries', 'criterion-categories'].includes(resource.key)) ||
    resource.key === 'standards'
      ? [
          {
            key: 'selection',
            width: 30,
            title: <Checkbox disabled aria-label={m.selectAll} />,
            render: () => <Checkbox disabled aria-label={m.selectRow} />,
          },
        ]
      : []),
    ...columns,
    {
      key: 'actions',
      title: m.actions,
      width: actionWidth(resource),
      render: (_: unknown, row: Row) => (
        <Space>
          {resource.key !== 'standards' && canButton(permission, 'update', 'detail') && (
            <Button type="link" loading={state.editing} onClick={() => void state.edit(row.id)}>
              {m.edit}
            </Button>
          )}
          {rowActionLabels(resource).map((label) => (
            <Button key={label} type="link" disabled>
              {label}
            </Button>
          ))}
        </Space>
      ),
    },
    ...(Object.keys(layout).length
      ? [
          {
            key: 'settings',
            width: resource.module === 'talent' ? 24 : 26,
            title: <Button className="catalog-column-settings" aria-label={m.columnSettings} disabled />,
          },
        ]
      : []),
  ];
}
function actionWidth(resource: Resource) {
  if (resource.key === 'libraries') return 147;
  if (resource.key === 'grade-schemes') return 148;
  if (resource.key === 'targets' || resource.module === 'talent') return 160;
  return 164;
}
function createLabel(resource: Resource) {
  if (resource.key === 'targets') return m.addTarget;
  if (resource.module === 'talent' && resource.key !== 'dimensions') return m.add;
  return m.create;
}
function rowActionLabels(resource: Resource) {
  if (resource.key === 'standards') return [m.setChannel, m.disabled];
  if (['categories', 'levels', 'targets'].includes(resource.key)) return [m.disabled];
  if (resource.key === 'grade-schemes') return [m.delete, m.disabled];
  if (resource.module === 'talent' && resource.key !== 'dimensions') return [m.delete];
  return [];
}
function timestamp(value: unknown, timezone: string) {
  if (typeof value !== 'string' || !timezone || !Number.isFinite(Date.parse(value))) return m.unknown;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}
function toolbar(resource: Resource) {
  if (resource.key === 'grade-schemes') return [];
  if (resource.key === 'criterion-categories') return [m.more];
  if (resource.key === 'libraries') return [m.import, m.enabled, m.disabled];
  if (resource.key === 'criteria') return [m.more];
  if (['categories', 'levels'].includes(resource.key)) return [m.importJobs, m.import];
  if (resource.key === 'standards') return [m.aiStandard, m.import, m.exportGraph];
  if (resource.key === 'targets') return [m.import, m.industryTargets];
  return [m.import];
}
function ResourceList({
  resource,
  permission,
  state,
}: {
  resource: Resource;
  permission: ObjectPermission;
  state: State;
}) {
  const { page, setPage, search, setSearch, list, reload, setEditor } = state;
  const shown = (list.data?.items ?? []).filter(
    (row) =>
      !fieldAccess(permission, 'name').visible ||
      !search ||
      (typeof row.name === 'string' && row.name.includes(search)),
  );
  return (
    <ListPage
      title={resource.key === 'targets' ? m.allTargets : resource.title}
      page={page}
      onPageChange={(next) => {
        setPage(next);
        setSearch('');
      }}
      data={{ ...list.data, items: shown }}
      rowKey="id"
      loading={list.loading}
      error={list.error}
      retry={reload}
      columns={resourceColumns(resource, permission, state)}
      filters={<ResourceFilters resource={resource} permission={permission} state={state} />}
      actions={
        <>
          {canButton(permission, 'create', 'list') && (
            <Button type="primary" onClick={() => setEditor({ original: null })}>
              {createLabel(resource)}
            </Button>
          )}
          {toolbar(resource).map((label) => (
            <Tooltip key={label} title={m.pending}>
              <Button disabled>{label}</Button>
            </Tooltip>
          ))}
        </>
      }
    />
  );
}
function ResourceFilters({
  resource,
  permission,
  state,
}: {
  resource: Resource;
  permission: ObjectPermission;
  state: State;
}) {
  const { search, setSearch, reload } = state;
  return (
    resource.key !== 'criterion-categories' && (
      <Space>
        {fieldAccess(permission, 'name').visible && (
          <Tooltip title={m.searchHint}>
            <Input.Search
              aria-label={alignment(resource).name?.label ?? m.search}
              placeholder={m.search}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              allowClear
            />
          </Tooltip>
        )}
        {[
          ...(resource.module === 'qualification' && ['categories', 'levels'].includes(resource.key) ? ['code'] : []),
          'enabled',
          ...(resource.key === 'criteria' ? ['categoryId'] : resource.key === 'libraries' ? ['type'] : []),
        ]
          .filter((key) => resource.key !== 'grade-schemes' && fieldAccess(permission, key).visible)
          .map((key) => (
            <Select
              key={key}
              disabled
              aria-label={resource.fields.find((f) => f.key === key)?.label}
              placeholder={resource.fields.find((f) => f.key === key)?.label}
              value={key === 'enabled' && state.defaultEnabled ? m.enabled : undefined}
              style={{ width: 120 }}
            />
          ))}
        <Button onClick={reload}>{m.refresh}</Button>
      </Space>
    )
  );
}

export function ResourcePage({ resource, permission }: { resource: Resource; permission: ObjectPermission }) {
  const state = useResourceState(resource, permission);
  return (
    <div className="catalog-page" data-aligned={!!Object.keys(alignment(resource)).length}>
      <DecisionNote id={resource.note} />
      {!!state.names.error && <PageState kind="error" error={state.names.error} retry={state.reload} />}
      {!!state.editError && <PageState kind="error" error={state.editError} retry={state.reload} />}
      <div hidden={!!state.view && fullPageDetail(resource)}>
        <div className="catalog-list-body">
          {resource.module === 'qualification' &&
            ['categories', 'standards', 'targets'].includes(resource.key) &&
            fieldAccess(
              permission,
              resource.key === 'targets' ? 'typeId' : resource.key === 'categories' ? 'classId' : 'categoryId',
            ).visible && (
              <CatalogTree
                resource={resource}
                selected={state.scope}
                onSelect={(id) => {
                  state.setScope(id);
                  state.setPage({ ...state.page, page: 1 });
                }}
              />
            )}
          <ResourceList resource={resource} permission={permission} state={state} />
        </div>
      </div>
      {(resource.key === 'standards' || resource.key === 'criteria') && (
        <Alert className="catalog-hint" type="info" message={m.limited} />
      )}
      {state.view && (
        <ResourceDetail
          key={state.view}
          resource={resource}
          id={state.view}
          permission={permission}
          onClose={() => state.setView(undefined)}
          onEdit={() => void state.edit(state.view!)}
        />
      )}
      {state.editor && (
        <ResourceForm
          resource={resource}
          original={state.editor.original}
          permission={permission}
          onClose={() => state.setEditor(undefined)}
          onSaved={state.reload}
        />
      )}
    </div>
  );
}
