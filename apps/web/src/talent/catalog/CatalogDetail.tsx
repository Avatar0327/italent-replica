import { Button, Space } from 'antd';
import type { ReactNode } from 'react';
import { m } from './messages.js';

/** 标准详情在模块内组合，避免改变其他页面共用的抽屉契约。 */
export function CatalogDetail(props: {
  title: string;
  onClose(): void;
  summary?: ReactNode;
  actions?: ReactNode;
  sections: { key: string; title: string; children: ReactNode }[];
}) {
  return (
    <section className="catalog-detail-page">
      <header>
        <h1>{props.title}</h1>
        <Space>
          {props.actions}
          <Button aria-label={m.back} onClick={props.onClose}>
            {m.back}
          </Button>
        </Space>
      </header>
      {props.summary && <div className="catalog-detail-summary">{props.summary}</div>}
      {props.sections.map((section) => (
        <section key={section.key}>{section.children}</section>
      ))}
    </section>
  );
}
