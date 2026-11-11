import { Button, Tooltip, type TableColumnsType } from 'antd';
import { internalUserGaps } from '../demo-stubs/settings-columns.js';
import type { User } from './model.js';
import { Status } from './parts.js';
import { m } from './messages.js';
import { columnGear, textValue } from './list-support.js';
export function userColumns(
  internal: boolean,
  detail: (id: string) => void,
  instant: (value?: string) => string = textValue,
): TableColumnsType<User> {
  const identity: TableColumnsType<User> = [
    {
      title: m.displayName,
      dataIndex: 'displayName',
      width: 128,
      fixed: 'left',
      render: (name: string, row: User) => (
        <Button type="link" onClick={() => detail(row.userId)}>
          {name}
        </Button>
      ),
    },
  ];
  const email = { title: m.email, dataIndex: 'email', width: 188 };
  const status = {
    title: m.status,
    dataIndex: 'membershipStatus',
    width: 128,
    render: (value: string) => <Status value={value} />,
  };
  const gaps = internalUserGaps.map((column) => ({
    ...column,
    render: () => (
      <Tooltip title={m.fieldPending}>
        <span>{m.empty}</span>
      </Tooltip>
    ),
  }));
  if (!internal)
    return [
      ...identity,
      { title: m.loginPhone, width: 128, render: () => m.empty },
      { ...email, dataIndex: 'contactEmail', render: textValue },
      { title: m.contactPhone, dataIndex: 'contactPhone', width: 128, render: textValue },
      {
        title: m.userType,
        dataIndex: 'userType',
        width: 128,
        render: (value: string | null) =>
          (({ internal: m.users, external: m.external }) as Record<string, string>)[value ?? ''] ?? value ?? m.empty,
      },
      { title: m.businessIdentity, dataIndex: 'businessIdentity', width: 128 },
      { title: m.accountSource, width: 128, render: () => m.empty },
      { title: m.createdBy, width: 118, render: () => m.empty },
      { title: m.createdAt, dataIndex: 'createdAt', width: 146, render: instant },
      {
        title: m.accountStatus,
        dataIndex: 'accountStatus',
        width: 128,
        render: (value?: string) =>
          (({ active: m.active, disabled: m.disabled }) as Record<string, string>)[value ?? ''] ?? m.empty,
      },
      {
        title: m.employeeStatus,
        dataIndex: 'employeeStatus',
        width: 128,
        render: (value?: string | null) => m.employeeStatuses[value as keyof typeof m.employeeStatuses] ?? m.empty,
      },
      columnGear,
    ];
  return [...identity, gaps[0]!, email, ...gaps.slice(1), status];
}
