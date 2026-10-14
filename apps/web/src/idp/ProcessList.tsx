import { Button, Popconfirm, Space, type TableColumnsType } from 'antd';
import { useMemo, useState, type ReactNode } from 'react';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { usePermissions } from '../foundation/Permissions.js';
import { ListPage } from '../foundation/templates.js';
import { IDP_API, OBJECTS, useAction, useCollection } from './api.js';
import { ActionError, HeaderActions, NameSearch, useLocalPage, yesNo } from './listing.js';
import { t } from './messages.js';
import { display } from './model.js';
import { ProcessForm } from './ProcessForm.js';
import type { Process } from './types.js';
import { useNames } from './useNames.js';

type View = 'enabled' | 'disabled';

/** 发展计划流程：按启用状态分两个视图；编辑在弹窗内完成（含子流程），删除走对象 revision。 */
export function ProcessList() {
  const permission = usePermissions(OBJECTS.process);
  const list = useCollection<Process>(`${IDP_API}/processes`);
  const [view, setView] = useState<View>('enabled');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id?: string }>();
  const action = useAction(list.reload);
  const rows = useMemo(
    () =>
      (list.items ?? []).filter(
        (row) => (row.enabled !== false) === (view === 'enabled') && (row.name ?? '').includes(name.trim()),
      ),
    [list.items, view, name],
  );
  const paging = useLocalPage(rows, list.loading);
  const orgs = useNames(
    'org',
    paging.shown.map((row) => row.orgId),
  );
  const remove = (row: Process) => void action.run(`${IDP_API}/processes/${row.id}`, 'DELETE', {}, row.revision!);
  const operations = (row: Process) => (
    <Space size={4}>
      {permission.can('update', 'detail') && (
        <Button type="link" disabled={action.busy} onClick={() => setEditing({ id: row.id })}>
          {t.actions.edit}
        </Button>
      )}
      {permission.can('delete', 'detail') && row.revision !== undefined && (
        <Popconfirm title={t.confirm.delete} onConfirm={() => remove(row)}>
          <Button type="link" danger disabled={action.busy || action.blocked}>
            {t.actions.delete}
          </Button>
        </Popconfirm>
      )}
    </Space>
  );
  return (
    <>
      <DecisionNote id="idp-processes" />
      {!!action.error && <ActionError error={action.error} reset={action.blocked && action.reset} />}
      <ListPage<Process>
        title={t.processes}
        view={{
          value: view,
          options: [
            { key: 'enabled', label: t.views.enabledProcesses },
            { key: 'disabled', label: t.views.disabledProcesses },
          ],
          onChange: (value) => {
            setView(value as View);
            paging.first();
          },
        }}
        data={{ items: paging.shown, total: rows.length, hasDataPermission: list.hasDataPermission }}
        columns={columns(permission.field, orgs, operations)}
        rowKey="id"
        page={paging.page}
        onPageChange={paging.change}
        loading={list.loading}
        error={list.error}
        retry={list.reload}
        filters={
          permission.field('name').visible && (
            <NameSearch
              value={name}
              change={(value) => {
                setName(value);
                paging.first();
              }}
            />
          )
        }
        actions={
          <HeaderActions create={permission.can('create', 'list') && (() => setEditing({}))} refresh={list.reload} />
        }
      />
      {editing && <ProcessForm id={editing.id} close={() => setEditing(undefined)} saved={list.reload} />}
    </>
  );
}

function columns(
  field: (name: string) => { visible: boolean },
  orgs: (id?: string | null) => string,
  operations: (row: Process) => ReactNode,
): TableColumnsType<Process> {
  const subNames = (row: Process) =>
    row.subProcesses?.length ? row.subProcesses.map((item) => item.name).join(' → ') : t.noValue;
  const all: (TableColumnsType<Process>[number] | false)[] = [
    field('name').visible && {
      key: 'name',
      title: t.fields.processName,
      width: 220,
      render: (_, row) => display(row.name),
    },
    field('orgId').visible && { key: 'orgId', title: t.fields.orgId, width: 160, render: (_, row) => orgs(row.orgId) },
    field('publicDown').visible && {
      key: 'publicDown',
      title: t.fields.publicDown,
      width: 90,
      render: (_, row) => yesNo(row.publicDown),
    },
    field('enabled').visible && {
      key: 'enabled',
      title: t.fields.enabled,
      width: 90,
      render: (_, row) => yesNo(row.enabled),
    },
    field('subProcesses').visible && {
      key: 'subProcesses',
      title: t.fields.subProcesses,
      ellipsis: true,
      render: (_, row) => subNames(row),
    },
    { key: 'operations', title: t.fields.operations, fixed: 'right', width: 140, render: (_, row) => operations(row) },
  ];
  return all.filter((column) => !!column) as TableColumnsType<Process>;
}
