import { isPageCarrier } from '@italent/domain';
import { Button, Input, Space, Table, Tabs, type TableColumnsType } from 'antd';
import { useState } from 'react';
import { PageState } from '../foundation/PageState.js';
import { type DialogMode, type ProfileDetail, profilePath } from './object-dialog-model.js';
import { ObjectPermissionDialog } from './ObjectPermissionDialog.js';
import { useResource } from './useResource.js';
import { om } from './object-messages.js';
import './object-permissions.css';
import { PagePermissions, ProfileMenus } from './PagePermissions.js';
import { pm } from './page-messages.js';
type ObjectRow = ProfileDetail['objects'][number];
type Target = { objectCode: string; mode: DialogMode };
export function ProfileDetails({ id, editable, close }: { id: string; editable: boolean; close(): void }) {
  const resource = useResource<ProfileDetail>(profilePath(id));
  const [dialog, setDialog] = useState<Target>();
  return (
    <section className="profile-object-page">
      <header>
        <h1>{resource.data?.name ?? om.objects}</h1>
        <Button onClick={close}>{om.back}</Button>
      </header>
      {resource.error ? (
        <PageState kind="error" error={resource.error} retry={resource.refresh} />
      ) : (
        <Tabs
          defaultActiveKey="objects"
          destroyOnHidden
          items={[
            { key: 'menus', label: pm.menus, children: resource.data && <ProfileMenus profile={resource.data} /> },
            {
              key: 'pages',
              label: pm.pages,
              children: resource.data && (
                <PagePermissions profile={resource.data} editable={editable} refresh={resource.refresh} />
              ),
            },
            {
              key: 'objects',
              label: om.objects,
              children: (
                <ObjectTable
                  rows={(resource.data?.objects ?? []).filter((row) => !isPageCarrier(row.objectCode))}
                  loading={resource.loading}
                  open={setDialog}
                />
              ),
            },
          ]}
        />
      )}
      {dialog && (
        <ObjectPermissionDialog
          key={`${id}/${dialog.objectCode}/${dialog.mode}`}
          id={id}
          {...dialog}
          editable={editable}
          close={() => setDialog(undefined)}
          saved={() => {
            setDialog(undefined);
            resource.refresh();
          }}
        />
      )}
    </section>
  );
}
function ObjectTable({ rows, loading, open }: { rows: ObjectRow[]; loading: boolean; open(target: Target): void }) {
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState({ current: 1, pageSize: 15 });
  const [expanded, setExpanded] = useState<string[]>([]);
  const objects = rows.filter((row) => row.objectCode.toLowerCase().includes(query.toLowerCase()));
  const apply = (value: string) => {
    setQuery(value.trim());
    setPage((p) => ({ ...p, current: 1 }));
  };
  return (
    <>
      <Space className="profile-object-filter">
        <Input
          aria-label={om.code}
          placeholder={om.code}
          maxLength={100}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Button onClick={() => apply(filter)}>{om.query}</Button>
        <Button
          onClick={() => {
            setFilter('');
            apply('');
          }}
        >
          {om.clear}
        </Button>
      </Space>
      <Table
        rowKey="objectCode"
        loading={loading}
        dataSource={objects}
        scroll={{ x: 1220 }}
        pagination={{
          ...page,
          total: objects.length,
          showTotal: om.total,
          showSizeChanger: {
            labelRender: ({ value }) => `${value}${om.perPage}`,
            optionRender: ({ value }) => `${value}${om.perPage}`,
          },
          pageSizeOptions: [15, 30, 50, 100],
          onChange: (current, pageSize) => setPage({ current: pageSize === page.pageSize ? current : 1, pageSize }),
        }}
        expandable={{
          showExpandColumn: false,
          expandedRowKeys: expanded,
          expandedRowRender: (row) => (
            <Table
              rowKey={(button) => `${button.buttonCode}/${button.level}`}
              pagination={false}
              dataSource={[...row.buttons]}
              columns={[
                { title: om.code, dataIndex: 'buttonCode' },
                { title: om.level, dataIndex: 'level' },
              ]}
            />
          ),
        }}
        columns={objectColumns(open, (code) => setExpanded(expanded.includes(code) ? [] : [code]))}
      />
    </>
  );
}
function objectColumns(open: (target: Target) => void, expand: (code: string) => void): TableColumnsType<ObjectRow> {
  return [
    { title: om.name, width: 180, render: () => om.empty },
    { title: om.code, dataIndex: 'objectCode', width: 180 },
    { title: om.app, width: 180, render: () => om.empty },
    { title: om.group, width: 180, render: () => om.empty },
    { title: om.updatedAt, width: 180, render: () => om.empty },
    {
      title: om.operation,
      width: 320,
      render: (_, row) => (
        <Space size={8}>
          <Button type="link" onClick={() => open({ objectCode: row.objectCode, mode: 'fields' })}>
            {om.fields}
          </Button>
          <Button type="link" onClick={() => expand(row.objectCode)}>
            {om.functions}
          </Button>
          <Button type="link" onClick={() => open({ objectCode: row.objectCode, mode: 'data-operations' })}>
            {om.data}
          </Button>
        </Space>
      ),
    },
  ];
}
