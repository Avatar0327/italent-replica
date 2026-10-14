import { Alert, Button, Descriptions, Empty, Tag } from 'antd';
import { NavLink } from 'react-router';
import type { ReactNode } from 'react';
import { DecisionNote, DetailPage, PageState } from '../../foundation/index.js';
import { ViewHeading } from '../../foundation/ViewHeading.js';
import type { OwnRecord } from '../../employee-self-service/types.js';
import { recordItems } from './model.js';
import { messages as m } from './messages.js';
import type { selfServiceDemo } from '../../demo-stubs/self-service.js';
import './pages.css';

export function ServiceNav({ manager = false }: { manager?: boolean }) {
  const links = manager
    ? [
        ['/manager', m.manager.title],
        ['/manager/team', m.manager.team],
        ['/manager/todos', m.todo],
        ['/manager/applications', m.records],
      ]
    : [
        ['/self', m.profile],
        ['/self/applications', m.records],
        ['/self/requests', m.applications],
      ];
  return (
    <nav className="service-nav" aria-label={manager ? m.manager.title : m.title}>
      {links.map(([to, title]) => (
        <NavLink key={to} to={to!} end>
          {title}
        </NavLink>
      ))}
    </nav>
  );
}
export function ServiceHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-heading">
      <ViewHeading title={title} />
      <div>{children}</div>
    </header>
  );
}
export function RecordInfo({ record }: { record: OwnRecord | null }) {
  return record ? <Descriptions column={2} items={recordItems(record)} /> : <Empty description={m.noProfile} />;
}
export function ReadState({ state }: { state: { loading: boolean; error?: unknown; refresh(): void } }) {
  if (state.error) return <PageState kind="error" error={state.error} retry={state.refresh} />;
  return state.loading ? <PageState kind="loading" /> : null;
}
export function DemoSection({ section }: { section: (typeof selfServiceDemo.sections)[number] }) {
  return (
    <section className="service-section" id={`demo-${section.key}`}>
      <h2>
        {section.title} <Tag color="gold">{m.demo}</Tag>
      </h2>
      <Alert type="info" message={m.demoHint} />
      {section.rows.length ? (
        <Descriptions
          className="service-demo-fields"
          column={2}
          items={section.rows.map((row) => ({ key: row.key, label: row.label, children: row.value }))}
        />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={m.notConnected} />
      )}
    </section>
  );
}
export function FormDrawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
}) {
  return (
    <DetailPage
      open={open}
      onClose={onClose}
      title={title}
      sections={[{ key: 'form', title: m.applicationInfo, children: <div className="service-form">{children}</div> }]}
    />
  );
}
export function Refresh({ onClick }: { onClick(): void }) {
  return <Button onClick={onClick}>{m.refresh}</Button>;
}
export function Notes({ id }: { id: string }) {
  return <DecisionNote id={id} />;
}
