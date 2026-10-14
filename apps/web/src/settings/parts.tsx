import { Alert, Descriptions, Tag } from 'antd';
import type { ReactNode } from 'react';
import { PageState } from '../foundation/PageState.js';
import { DetailPage } from '../foundation/templates.js';
import { useResource } from './useResource.js';
import { m } from './messages.js';
export function Status({ value }: { value: string }) {
  const labels: Record<string, string> = {
    active: m.active,
    disabled: m.disabled,
    revoked: m.revoked,
    standard: m.standard,
    custom: m.custom,
    manual: m.manual,
    auto: m.auto,
  };
  return <Tag color={value === 'active' ? 'green' : undefined}>{labels[value] ?? value}</Tag>;
}
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <Descriptions
      column={2}
      size="small"
      items={items.map(([label, children], index) => ({
        key: index,
        label,
        children: children ?? m.empty,
      }))}
    />
  );
}
export function RemoteDetail<T>({
  path,
  title,
  close,
  children,
}: {
  path: string;
  title: string;
  close(): void;
  children(data: T): ReactNode;
}) {
  const resource = useResource<T>(path);
  let content: ReactNode = <PageState kind="loading" />;
  if (resource.error) content = <PageState kind="error" error={resource.error} retry={resource.refresh} />;
  else if (resource.data) content = children(resource.data);
  return (
    <DetailPage
      open
      onClose={close}
      title={title}
      sections={[
        {
          key: 'detail',
          title: m.basic,
          children: content,
        },
      ]}
    />
  );
}
export function Notice({ text }: { text: string }) {
  return <Alert className="settings-notice" type="info" showIcon message={text} />;
}
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return m.empty;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
