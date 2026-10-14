import { Button, Tooltip, type TableColumnsType } from 'antd';
import { internalUserGaps, allUserGaps } from '../demo-stubs/settings-columns.js';
import type { User } from './model.js';
import { Status } from './parts.js';
import { m } from './messages.js';
export function userColumns(internal: boolean, detail: (id: string) => void): TableColumnsType<User> {
  const identity: TableColumnsType<User> = [
    {
      title: m.displayName,
      dataIndex: 'displayName',
      width: 130,
      fixed: 'left',
      render: (name: string, row: User) => (
        <Button type="link" onClick={() => detail(row.userId)}>
          {name}
        </Button>
      ),
    },
  ];
  const email = { title: m.email, dataIndex: 'email', width: 200 };
  const status = {
    title: m.status,
    dataIndex: 'membershipStatus',
    width: 100,
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
      gaps[0]!,
      email,
      gaps[1]!,
      {
        title: m.userType,
        dataIndex: 'userType',
        width: 110,
        render: (value: string | null) =>
          (({ internal: m.users, external: m.external }) as Record<string, string>)[value ?? ''] ?? value ?? m.empty,
      },
      { title: m.businessIdentity, dataIndex: 'businessIdentity', width: 130 },
      ...allUserGaps.map((column) => ({
        ...column,
        render: () => (
          <Tooltip title={m.fieldPending}>
            <span>{m.empty}</span>
          </Tooltip>
        ),
      })),
      status,
    ];
  return [...identity, gaps[0]!, email, ...gaps.slice(1), status];
}
