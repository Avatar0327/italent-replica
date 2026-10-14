import { Alert, Descriptions, Tag } from 'antd';
import type { ReactNode } from 'react';
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
export function Fields({
  row,
  keys,
  allowed,
  labels = {},
  render = (key) => value(row[key], key),
}: {
  row: Row;
  keys: string[];
  allowed?: readonly string[];
  labels?: Record<string, string>;
  render?: (key: string) => ReactNode;
}) {
  return (
    <Descriptions
      column={2}
      size="small"
      items={keys
        .filter((key) => !allowed || allowed.includes(key))
        .map((key) => ({ key, label: labels[key] ?? m.fields[key] ?? key, children: render(key) }))}
    />
  );
}
