import { Button } from 'antd';
import type { Profile } from './model.js';
import { columnGear, textValue } from './list-support.js';
import { m } from './messages.js';
export function profileColumns(detail: (id: string) => void, instant: (value?: string) => string) {
  return [
    {
      title: m.name,
      dataIndex: 'name',
      width: 193,
      render: (name: string, row: Profile) => (
        <Button type="link" onClick={() => detail(row.id)}>
          {name}
        </Button>
      ),
    },
    { title: m.code, dataIndex: 'code', width: 128 },
    { title: m.apps, dataIndex: 'apps', width: 128, render: (apps: string[]) => apps.join('、') || m.empty },
    {
      title: m.grantScope,
      width: 128,
      render: (_: unknown, row: Profile) => {
        if (row.autoHeld) return m.autoHeld;
        return row.grantCount === undefined ? m.empty : m.grantCount(row.grantCount);
      },
    },
    {
      title: m.source,
      dataIndex: 'source',
      width: 128,
      render: (value: string) => (value === 'standard' ? m.standard : m.custom),
    },
    { title: m.profileDescription, dataIndex: 'description', width: 128 },
    { title: m.status, width: 128, render: () => m.empty },
    { title: m.updatedBy, width: 118, render: (_: unknown, row: Profile) => textValue(row.updatedBy?.displayName) },
    { title: m.updatedAt, dataIndex: 'updatedAt', width: 146, render: instant },
    { title: m.owningApp, width: 128, render: () => m.empty },
    {
      title: m.operation,
      width: 168,
      render: (_: unknown, row: Profile) => (
        <Button type="link" onClick={() => detail(row.id)}>
          {m.detail}
        </Button>
      ),
    },
    columnGear,
  ];
}
