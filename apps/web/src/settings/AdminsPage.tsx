import { useResource } from './useResource.js';
import { serverTreeData, type ServerOrgTree } from '../org/page-model.js';
import { Notice } from './parts.js';
import { Button } from 'antd';
import { ADMIN_ROLE_NAMES, ADMIN_ROLES, type AdminRole } from '@italent/domain';
import { ListPage } from '../foundation/templates.js';
import type { SettingsProps } from './SettingsPage.js';
import type { AdminRow } from './model.js';
import { ListFilters } from './ListFilters.js';
import {
  useSettingsList,
  useListInstant,
  useRowSelection,
  columnGear,
  mouOptions,
  mouText,
  textValue,
} from './list-support.js';
import { m } from './messages.js';
export function AdminsPage({ title }: SettingsProps) {
  const list = useSettingsList<AdminRow>('admins');
  const organizations = useResource<ServerOrgTree>('/api/tenant/org/organizations/tree?dimension=admin');
  const items = list.data?.items ?? [];
  const selection = useRowSelection(items, (row) => row.id);
  const instant = useListInstant();
  return (
    <ListPage
      title={title}
      rowKey="id"
      page={list.page}
      onPageChange={list.setPage}
      data={list.data ?? { items: [] }}
      loading={list.loading}
      error={list.error}
      retry={list.refresh}
      filters={
        <>
          {organizations.error && <Notice text={m.orgLoadFailed} />}
          <ListFilters
            apply={list.apply}
            fields={[
              { name: 'q', label: m.personSearch },
              {
                name: 'departmentId',
                label: m.department,
                treeData: serverTreeData(organizations.data?.roots ?? []),
                loading: organizations.loading,
              },
              {
                name: 'role',
                label: m.profileId,
                options: ADMIN_ROLES.map((role) => ({ value: role, label: ADMIN_ROLE_NAMES[role] })),
              },
              { name: 'mouId', label: m.mous, pageCandidates: true, options: mouOptions(items) },
            ]}
          />
        </>
      }
      actions={
        <Button
          onClick={() => {
            list.refresh();
            organizations.refresh();
          }}
        >
          {m.refresh}
        </Button>
      }
      columns={[
        ...selection,
        { title: m.displayName, dataIndex: 'displayName', width: 134 },
        { title: m.listEmail, dataIndex: 'email', width: 194, render: textValue },
        { title: m.department, width: 134, render: (_: unknown, row: AdminRow) => textValue(row.department?.name) },
        { title: m.mous, dataIndex: 'mous', width: 134, render: mouText },
        {
          title: m.profileId,
          dataIndex: 'role',
          width: 134,
          render: (role: AdminRole) => ADMIN_ROLE_NAMES[role] ?? m.empty,
        },
        { title: m.createdAt, dataIndex: 'createdAt', width: 152, render: instant },
        {
          title: m.createdBy,
          width: 124,
          render: (_: unknown, row: AdminRow) => textValue(row.createdBy?.displayName),
        },
        { title: m.operation, width: 160, render: () => m.empty },
        columnGear,
      ]}
    />
  );
}
