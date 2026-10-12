import { Alert, Button, Input, Space, Tag, Tooltip } from 'antd';
import { useState } from 'react';
import { DecisionNote } from '../../foundation/DecisionNote.js';
import { PageState } from '../../foundation/PageState.js';
import { ListPage } from '../../foundation/templates.js';
import { canButton, fieldAccess, type ObjectPermission } from '../../foundation/permission-model.js';
import { useApiClient } from '../../foundation/Session.js';
import { listResource, resourcePath } from './api.js';
import { useRemote, useReferenceNames } from './hooks.js';
import { ResourceDetail, display } from './ResourceDetail.js';
import { ResourceForm } from './ResourceForm.js';
import type { Resource, Row } from './types.js';
import { m } from './messages.js';

function useResourceState(resource: Resource) {
  const api = useApiClient();
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [generation, refresh] = useState(0);
  const names = useReferenceNames(resource, generation);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<string>();
  const [editor, setEditor] = useState<{ original: Row | null }>();
  const [editError, setEditError] = useState<unknown>();
  const [editing, setEditing] = useState(false);
  const list = useRemote(`list:${resource.object}:${page.page}:${page.pageSize}:${generation}`, (client) =>
    listResource(client, resource, page),
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
  const columns = resource.columns
    .filter((key) => fieldAccess(permission, key).visible)
    .map((key) => ({
      key,
      dataIndex: key,
      title: resource.fields.find((field) => field.key === key)?.label ?? key,
      render: (value: unknown, row: Row) =>
        key === 'name' ? (
          <Button type="link" className="catalog-name" onClick={() => state.setView(row.id)}>
            {display(value)}
          </Button>
        ) : key === 'enabled' && typeof value === 'boolean' ? (
          <Tag color={value ? 'green' : 'default'}>{display(value)}</Tag>
        ) : (
          display(typeof value === 'string' ? (state.names.data?.get(value) ?? value) : value)
        ),
    }));
  return [
    ...columns,
    {
      key: 'actions',
      title: m.actions,
      render: (_: unknown, row: Row) => (
        <Space>
          <Button type="link" onClick={() => state.setView(row.id)}>
            {m.view}
          </Button>
          {canButton(permission, 'update', 'detail') && (
            <Button type="link" loading={state.editing} onClick={() => void state.edit(row.id)}>
              {m.edit}
            </Button>
          )}
        </Space>
      ),
    },
  ];
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
    (row) => !search || (typeof row.name === 'string' && row.name.includes(search)),
  );
  return (
    <ListPage
      title={resource.title}
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
      filters={
        <Space>
          <Tooltip title={m.searchHint}>
            <Input.Search
              aria-label={m.search}
              placeholder={m.search}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              allowClear
            />
          </Tooltip>
          <Button onClick={reload}>{m.refresh}</Button>
        </Space>
      }
      actions={
        <>
          {canButton(permission, 'create', 'list') && (
            <Button type="primary" onClick={() => setEditor({ original: null })}>
              {m.create}
            </Button>
          )}
          <Tooltip title={m.pending}>
            <Button disabled>{m.import}</Button>
          </Tooltip>
        </>
      }
    />
  );
}
export function ResourcePage({ resource, permission }: { resource: Resource; permission: ObjectPermission }) {
  const state = useResourceState(resource);
  return (
    <div className="catalog-page">
      <DecisionNote id={resource.note} />
      {!!state.names.error && <PageState kind="error" error={state.names.error} retry={state.reload} />}
      {!!state.editError && <PageState kind="error" error={state.editError} retry={state.reload} />}
      <ResourceList resource={resource} permission={permission} state={state} />
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
