import { Alert, Button, Descriptions, Drawer, Select, Space, Table, Tag } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ListPage } from '../foundation/templates.js';
import { usePermissions } from '../foundation/Permissions.js';
import { PageState } from '../foundation/PageState.js';
import { pageQuery, type PageResult } from '../foundation/client.js';
import { EV } from './ActivityFields.js';
import { Failure, useRead } from './runtime.js';
import { columnsFor, evUi, FilterLabels, settingColumns, settingsColumn, Unavailable } from './alignment.js';
import { records, type Row } from './model.js';
import { m, textValue } from './messages.js';
import { EvaluationFormEditor } from './EvaluationFormEditor.js';

export function SettingsPage({ kind }: { kind: 'forms' | 'groups' }) {
  const object = `TEvaluation.${kind === 'forms' ? 'EvaluationForm' : 'ReviewGroup'}`;
  const permission = usePermissions(object);
  const [query, setQuery] = useSearchParams();
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [enabled, filter] = useState<string>('true');
  const path = `${EV}/${kind === 'forms' ? 'evaluation-forms' : 'review-groups'}`;
  const params = pageQuery(page);
  if (enabled && permission.field('enabled').visible) params.set('enabled', enabled);
  const list = useRead<PageResult<Row>>(`${path}?${params}`);
  const id = query.get('edit') ?? query.get('detail');
  const detail = useRead<Row>(id ? `${path}/${id}` : undefined);
  const open = (key?: string, id?: string) => setQuery(key && id ? { view: kind, [key]: id } : { view: kind });
  const columns = settingListColumns(kind, permission, (id) => open('detail', id));
  if (kind === 'forms' && query.has('edit'))
    return detail.data ? (
      <EvaluationFormEditor row={detail.data} close={() => open()} saved={list.reload} />
    ) : (
      <>
        <Button onClick={() => open()}>{evUi.back}</Button>
        <PageState kind={detail.error ? 'error' : 'loading'} error={detail.error} retry={detail.reload} />
      </>
    );
  return (
    <>
      <ListPage
        title={evUi[kind]}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        data={list.data ?? { items: [] }}
        loading={list.loading}
        error={list.error}
        retry={list.reload}
        columns={[...columns, settingRowActions(kind, permission, open), settingsColumn]}
        filters={
          <SettingsFilters
            permission={permission}
            enabled={enabled}
            change={(value) => {
              filter(value);
              setPage({ ...page, page: 1 });
            }}
          />
        }
        actions={
          <Space>
            <Button onClick={() => setQuery({ view: 'activities' })}>{evUi.back}</Button>
            <Unavailable label={evUi.new} reason={evUi.unverified} />
            {kind === 'groups' && <Unavailable label="导入" />}
          </Space>
        }
      />
      {kind === 'groups' && id && <GroupDetail detail={detail} permission={permission} close={() => open()} />}
    </>
  );
}

function settingRowActions(
  kind: 'forms' | 'groups',
  permission: ReturnType<typeof usePermissions>,
  open: (key: string, id: string) => void,
) {
  return {
    key: 'actions',
    title: m.actions,
    width: 164,
    render: (_: unknown, row: Row) => (
      <Space>
        {kind === 'groups' && !permission.field('name').visible && (
          <Button type="link" onClick={() => open('detail', row.id)}>
            {m.view}
          </Button>
        )}
        {kind === 'forms' && permission.can('update') ? (
          <Button type="link" onClick={() => open('edit', row.id)}>
            {m.edit}
          </Button>
        ) : (
          <Unavailable label={m.edit} reason={evUi.unverified} />
        )}
        <Unavailable label={evUi.disabled} />
      </Space>
    ),
  };
}

function GroupDetail({
  detail,
  permission,
  close,
}: {
  detail: ReturnType<typeof useRead<Row>>;
  permission: ReturnType<typeof usePermissions>;
  close(): void;
}) {
  return (
    <Drawer
      open
      width={1000}
      title={permission.field('name').visible ? textValue(detail.data?.name) : m.noValue}
      extra={<Unavailable label={m.edit} />}
      onClose={close}
    >
      <Failure error={detail.error} retry={detail.reload} />
      {detail.loading ? (
        <PageState kind="loading" />
      ) : (
        detail.data && (
          <>
            <Descriptions
              items={
                permission.field('ownerOrgId').visible
                  ? [{ key: 'org', label: m.ownerOrgId, children: textValue(detail.data.ownerOrgId) }]
                  : []
              }
            />
            <FilterLabels permission={permission} fields={[['members', m.employeeId]]} />
            <Table
              pagination={false}
              rowKey="employeeId"
              dataSource={permission.field('members').visible ? records(detail.data.members) : []}
              columns={[
                {
                  title: m.employeeId,
                  width: 228,
                  render: (_: unknown, row: Record<string, unknown>) => (
                    <>
                      {textValue(row.name)} {row.isLeader === true && <Tag>组长</Tag>}
                    </>
                  ),
                },
                ...['部门', '任职类别', '任职级别'].map((title) => ({
                  title,
                  width: 219,
                  render: () => m.noValue,
                })),
              ]}
            />
            <Alert type="info" message={evUi.missingDisplay} />
          </>
        )
      )}
    </Drawer>
  );
}

function SettingsFilters({
  permission,
  enabled,
  change,
}: {
  permission: ReturnType<typeof usePermissions>;
  enabled: string;
  change(value: string): void;
}) {
  return (
    <FilterLabels permission={permission} fields={[['name', m.name]]}>
      {permission.field('enabled').visible && (
        <Select
          aria-label={m.status}
          value={enabled}
          style={{ width: 130 }}
          options={['', 'true', 'false'].map((value) => ({
            value,
            label: value ? (value === 'true' ? evUi.enabled : evUi.disabled) : m.all,
          }))}
          onChange={change}
        />
      )}
      <Button type="link" onClick={() => change('')}>
        {evUi.clear}
      </Button>
    </FilterLabels>
  );
}

function settingListColumns(
  kind: 'forms' | 'groups',
  permission: ReturnType<typeof usePermissions>,
  open: (id: string) => void,
) {
  return columnsFor(settingColumns[kind]!, permission).map((column) => ({
    ...column,
    render: (value: unknown, row: Row) => {
      if (column.dataIndex === 'name' && kind === 'groups')
        return (
          <Button type="link" onClick={() => open(row.id)}>
            {textValue(value)}
          </Button>
        );
      if (column.dataIndex !== 'members') return column.render(value, row);
      if (!Array.isArray(value)) return m.noValue;
      const members = records(value);
      return column.title === '人数'
        ? members.length
        : (column.title === '组长' ? members.filter((member) => member.isLeader) : members)
            .map((member) => textValue(member.name))
            .join('、') || m.noValue;
    },
  }));
}
