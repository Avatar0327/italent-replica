import { Alert, Descriptions, Tag } from 'antd';
import type { ReactNode } from 'react';
import { m } from './messages.js';
import { value, type Row } from './model.js';
import { NameOf, refPaths } from './references.js';
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
export const employmentOf = (row?: Row) =>
  row?.employment && typeof row.employment === 'object' ? (row.employment as Row) : undefined;
/**
 * 任职信息六项（原站顺序）：任职摘要只给 ID，部门 / 职务名称按业务日解析；机构 / 直线经理 / 虚线经理后端未提供，显示“--”。
 * 详情与新签 / 变更 / 续签表单共用。
 */
export function employmentItems(employment: Row | undefined, asOf?: string) {
  const missing = '--';
  return [
    { key: 'entryDate', children: employment ? value(employment.entryDate, 'entryDate') : missing },
    { key: 'organization', children: missing },
    {
      key: 'department',
      children: <NameOf path={refPaths.departmentId} id={employment?.departmentId} asOf={asOf} />,
    },
    { key: 'job', children: <NameOf path={refPaths.postId} id={employment?.postId} /> },
    { key: 'manager', children: missing },
    { key: 'dottedManager', children: missing },
  ].map((item) => ({ ...item, label: m.fields[item.key]! }));
}
