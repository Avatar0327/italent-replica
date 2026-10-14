import { Alert, Descriptions, Tag } from 'antd';
import { m } from './messages.js';
import { value, type Row } from './model.js';
export function DemoNote({ detail = m.demoHint }: { detail?: string }) {
  return (
    <Alert
      type="info"
      showIcon
      message={
        <>
          <Tag color="blue">{m.demo}</Tag>
          {detail}
        </>
      }
    />
  );
}
export function Fields({ row, keys, allowed }: { row: Row; keys: string[]; allowed?: readonly string[] }) {
  return (
    <Descriptions
      column={2}
      size="small"
      items={keys
        .filter((key) => !allowed || allowed.includes(key))
        .map((key) => ({
          key,
          label: m.fields[key] ?? key,
          children: value(row[key], key),
        }))}
    />
  );
}
