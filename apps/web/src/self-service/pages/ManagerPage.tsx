import { Button, Card, Descriptions, Empty, Form, Input, Select, Space, Tabs, Tag, type TableColumnsType } from 'antd';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import {
  DetailPage,
  FilterDrawer,
  ListPage,
  PageState,
  tenantDate,
  useSession,
  type PageResult,
} from '../../foundation/index.js';
import { ApplicationDrawer } from './ApplicationDrawer.js';
import { PersonAvatar } from '../../shared/PersonAvatar.js';
import type { AvatarReference } from '../../account/avatar-api.js';
import { selfServiceDemo } from '../../demo-stubs/self-service.js';
import {
  MANAGER,
  instant,
  managerListPath,
  statusText,
  teamKeys,
  teamLabels,
  teamValue,
  type TeamRow,
  type TodoRow,
} from './model.js';
import { Notes, ReadState, Refresh, ServiceHeading, ServiceNav } from './parts.js';
import { useRead } from './useRead.js';
import { messages as m } from './messages.js';

interface TeamResult extends PageResult<TeamRow> {
  counts?: Record<string, number | null>;
}
type Entry = { canApply: boolean; canViewReporting: boolean };
const categories = Object.entries(m.manager.categories).map(([value, label]) => ({ value, label }));

export function ManagerPage() {
  const path = useLocation().pathname;
  const session = useSession();
  const entry = useRead<Entry>(MANAGER);
  return (
    <div className="service-page" key={`${session.tenantId}/${session.identityKey}`}>
      <ServiceNav manager />
      {entry.data ? <ManagerWorkspace path={path} entry={entry.data} /> : <ReadState state={entry} />}
    </div>
  );
}
function ManagerWorkspace({ path, entry }: { path: string; entry: Entry }) {
  switch (path) {
    case '/manager':
      return <Dashboard />;
    case '/manager/team':
      return <TeamPage />;
    case '/manager/todos':
      return <TodosPage />;
    case '/manager/applications':
      return <ManagerApplications allowed={entry.canApply} />;
    default:
      return <PageState kind="not-found" />;
  }
}
function Dashboard() {
  const session = useSession();
  const team = useRead<TeamResult>(`${MANAGER}/team?page=1&pageSize=1`);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  return (
    <>
      <Notes id="manager.team" />
      <ServiceHeading title={m.manager.title} />
      <div className="service-welcome">
        <strong>{tenantDate(new Date(), session.timezone)}</strong>
        <span>{m.teamHint}</span>
      </div>
      <div className="service-dashboard">
        <div>
          <Card title={m.manager.team} extra={<Link to="/manager/team">{m.all}</Link>}>
            <ReadState state={team} />
            <div className="service-counts">
              {categories.map((item) => (
                <Button key={item.value} onClick={() => setCategory(item.value)} disabled={!team.data}>
                  <span>{item.label}</span>
                  <strong>{team.data?.counts?.[item.value] ?? m.none}</strong>
                </Button>
              ))}
            </div>
          </Card>
          <TodosPage compact />
        </div>
        <div>
          <Card title={m.manager.search}>
            <Input.Search
              aria-label={m.manager.query}
              placeholder={m.manager.query}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onSearch={(value) => {
                if (value.trim()) setSearch(value.trim());
              }}
              enterButton={m.search}
            />
          </Card>
          {selfServiceDemo.widgets.map((title) => (
            <Card key={title} title={title} extra={<Tag color="gold">{m.demo}</Tag>}>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={m.demoWidget} />
            </Card>
          ))}
        </div>
      </div>
      <DetailPage
        open={category !== null || search !== null}
        onClose={() => {
          setCategory(null);
          setSearch(null);
        }}
        title={
          search !== null
            ? m.manager.search
            : (m.manager.categories[category as keyof typeof m.manager.categories] ?? m.manager.team)
        }
        sections={[
          {
            key: 'team',
            title: m.teamInfo,
            children: (
              <TeamPage
                key={`${category}/${search}`}
                initialCategory={category ?? ''}
                initialSearch={search ?? ''}
                nested
              />
            ),
          },
        ]}
      />
    </>
  );
}
function useTeam(initialCategory: string, initialSearch: string) {
  const { tenantId } = useSession();
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [category, setCategory] = useState(initialCategory);
  const [search, setSearch] = useState(initialSearch);
  const [input, setInput] = useState(initialSearch);
  const [filter, setFilter] = useState(false);
  const [draftCategory, setDraftCategory] = useState(category);
  const [selected, setSelected] = useState<TeamRow | null>(null);
  const result = useRead<TeamResult>(managerListPath('team', page, category, search));
  const rows = result.data?.items ?? [];
  const keys = teamKeys(rows);
  const apply = (nextCategory: string, nextSearch: string) => {
    setCategory(nextCategory);
    setSearch(nextSearch);
    setInput(nextSearch);
    setPage({ ...page, page: 1 });
    setSelected(null);
  };
  const columns: TableColumnsType<TeamRow> = keys.map((key) => ({
    key,
    title: teamLabels[key],
    render: (_: unknown, row: TeamRow) =>
      key === 'name' && Object.hasOwn(row, key) ? (
        <Space>
          <PersonAvatar
            tenantId={tenantId}
            name={teamValue(row, key)}
            avatar={row.avatar as AvatarReference | null}
            size={20}
          />
          <Button type="link" onClick={() => setSelected(row)}>
            {teamValue(row, key)}
          </Button>
        </Space>
      ) : (
        teamValue(row, key)
      ),
  }));
  return {
    page,
    setPage,
    category,
    search,
    input,
    setInput,
    filter,
    setFilter,
    draftCategory,
    setDraftCategory,
    selected,
    setSelected,
    result,
    rows,
    apply,
    columns,
  };
}
function TeamPage({
  initialCategory = 'active',
  initialSearch = '',
  nested = false,
}: {
  initialCategory?: string;
  initialSearch?: string;
  nested?: boolean;
}) {
  const state = useTeam(initialCategory, initialSearch);
  const { page, setPage, selected, setSelected, result, rows, columns } = state;
  return (
    <>
      {!nested && <Notes id="manager.team" />}
      <ListPage
        title={m.manager.team}
        rowKey={(row: TeamRow) => String(row.id)}
        data={{ ...result.data, items: rows }}
        columns={columns}
        page={page}
        onPageChange={(next) => {
          setSelected(null);
          setPage(next);
        }}
        loading={result.loading}
        error={result.error}
        retry={result.refresh}
        actions={
          <Refresh
            onClick={() => {
              setSelected(null);
              result.refresh();
            }}
          />
        }
        filters={<TeamFilters state={state} />}
      />
      <TeamFilterDrawer state={state} />
      <DetailPage
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? teamValue(selected, 'name') : m.teamInfo}
        tabs={[
          {
            key: 'person',
            label: m.teamInfo,
            children: selected ? (
              <Descriptions
                column={2}
                items={teamKeys([selected]).map((key) => ({
                  key,
                  label: teamLabels[key],
                  children: teamValue(selected, key),
                }))}
              />
            ) : null,
          },
        ]}
      />
    </>
  );
}
function TeamFilters({ state }: { state: ReturnType<typeof useTeam> }) {
  const { category, search, input, setInput, setDraftCategory, setFilter, apply } = state;
  return (
    <Space wrap>
      <Select
        aria-label={m.personCategory}
        value={category}
        options={[{ value: '', label: m.all }, ...categories]}
        onChange={(value) => apply(value, search)}
        className="service-category-filter"
      />
      <Input.Search
        aria-label={m.manager.query}
        placeholder={m.manager.query}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onSearch={(value) => apply(category, value)}
        allowClear
        className="service-search-filter"
      />
      <Button
        type="link"
        onClick={() => {
          setDraftCategory(category);
          setFilter(true);
        }}
      >
        {m.advanced}
      </Button>
    </Space>
  );
}
function TeamFilterDrawer({ state }: { state: ReturnType<typeof useTeam> }) {
  const { filter, setFilter, draftCategory, setDraftCategory, apply, search } = state;
  return (
    <FilterDrawer
      open={filter}
      onClose={() => setFilter(false)}
      onClear={() => setDraftCategory('')}
      onApply={() => {
        apply(draftCategory, search);
        setFilter(false);
      }}
    >
      <Form layout="vertical">
        <Form.Item label={m.personCategory}>
          <Select
            value={draftCategory}
            onChange={setDraftCategory}
            options={[{ value: '', label: m.all }, ...categories]}
          />
        </Form.Item>
      </Form>
    </FilterDrawer>
  );
}
function TodosPage({ compact = false }: { compact?: boolean }) {
  const [tab, setTab] = useState('pending');
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [selected, setSelected] = useState<TodoRow | null>(null);
  const session = useSession();
  const result = useRead<PageResult<TodoRow>>(managerListPath('todos', page, tab));
  const columns: TableColumnsType<TodoRow> = [
    {
      title: m.titleLabel,
      dataIndex: 'title',
      render: (title: string, row) => (
        <Button type="link" onClick={() => setSelected(row)}>
          {title}
        </Button>
      ),
    },
    { title: m.node, dataIndex: 'nodeName', render: (value?: string) => value ?? m.none },
    {
      title: tab === 'pending' ? m.processingStatus : m.approval,
      render: (_: unknown, row) => (tab === 'pending' ? m.manager.pending : statusText(row.status)),
    },
    { title: m.submittedAt, dataIndex: 'createdAt', render: (value?: string) => instant(value, session.timezone) },
  ];
  return (
    <section className={compact ? 'service-todo-card' : ''}>
      <Notes id="manager.todos" />
      <ListPage
        title={m.todo}
        columns={columns}
        data={result.data ?? { items: [] }}
        rowKey={(row) => row.taskId ?? row.id!}
        page={page}
        onPageChange={(next) => {
          setSelected(null);
          setPage(next);
        }}
        loading={result.loading}
        error={result.error}
        retry={result.refresh}
        actions={
          <Refresh
            onClick={() => {
              setSelected(null);
              result.refresh();
            }}
          />
        }
        filters={
          <Tabs
            activeKey={tab}
            onChange={(key) => {
              setTab(key);
              setPage({ ...page, page: 1 });
              setSelected(null);
            }}
            items={(['pending', 'processed', 'initiated'] as const).map((key) => ({ key, label: m.manager[key] }))}
          />
        }
      />
      <TodoDetail selected={selected} pending={tab === 'pending'} onClose={() => setSelected(null)} />
    </section>
  );
}
function TodoDetail({ selected, pending, onClose }: { selected: TodoRow | null; pending: boolean; onClose(): void }) {
  const session = useSession();
  return (
    <DetailPage
      open={selected !== null}
      onClose={onClose}
      title={selected?.title ?? m.todo}
      actions={
        <Link to="/approval">
          <Button type="primary">{m.approvalCenter}</Button>
        </Link>
      }
      tabs={[
        {
          key: 'summary',
          label: m.todoInfo,
          children: selected && (
            <Descriptions
              column={2}
              items={[
                { key: 'title', label: m.titleLabel, children: selected.title },
                { key: 'node', label: m.node, children: selected.nodeName ?? m.none },
                {
                  key: 'status',
                  label: pending ? m.processingStatus : m.approval,
                  children: pending ? m.manager.pending : statusText(selected.status),
                },
                { key: 'time', label: m.submittedAt, children: instant(selected.createdAt, session.timezone) },
              ]}
            />
          ),
        },
      ]}
    />
  );
}
function ManagerApplications({ allowed }: { allowed: boolean }) {
  const [open, setOpen] = useState(false);
  const { tenantId } = useSession();
  return (
    <>
      <Notes id="self.applications" />
      <ServiceHeading title={m.records}>
        {allowed && (
          <Button type="primary" onClick={() => setOpen(true)}>
            {m.manager.apply}
          </Button>
        )}
      </ServiceHeading>
      <div className="service-section">
        <p>{m.applyHint}</p>
        {!allowed && <PageState kind="forbidden" />}
      </div>
      <ApplicationDrawer open={open && allowed} onClose={() => setOpen(false)} tenantId={tenantId} />
    </>
  );
}
