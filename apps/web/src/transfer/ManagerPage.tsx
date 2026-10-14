import { managerText as labels } from './manager-messages.js';
import { useEffect, useState } from 'react';
import { TransferApplication, SelfServiceShell, EmploymentList } from '../self-service/shared/index.js';
import { transferRequest, requestError, TRANSFER_API } from './api.js';
import { text } from './messages.js';
import './transfer.css';
import { PersonAvatar } from '../shared/PersonAvatar.js';
import type { AvatarReference } from '../account/avatar-api.js';

type Row = { [key: string]: string | number | boolean | null | Record<string, unknown> };
type Result = { items: Row[]; counts?: Record<string, number | null>; pageSize?: number };
type Entry = { canApply: boolean; canViewReporting: boolean };

export function ManagerPage() {
  return (
    <SelfServiceShell title={labels.title}>
      {(tenantId) => <ManagerWorkspace key={tenantId} tenantId={tenantId} />}
    </SelfServiceShell>
  );
}

function ManagerWorkspace({ tenantId }: { tenantId: string }) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState('dashboard');
  const [apply, setApply] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void transferRequest<Entry>(tenantId, `${TRANSFER_API}/manager`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setEntry(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(requestError(cause));
      });
    return () => controller.abort();
  }, [tenantId]);
  if (!entry) return <p role={error ? 'alert' : 'status'}>{error || text.loading}</p>;
  return (
    <section className="transfer-content">
      <nav className="transfer-actions" aria-label={labels.title}>
        <button onClick={() => setPage('dashboard')}>{labels.title}</button>
        <button onClick={() => setPage('applications')}>{labels.applications}</button>
        {entry.canViewReporting && <button onClick={() => setPage('reporting')}>{labels.reporting}</button>}
      </nav>
      {page === 'dashboard' && <Dashboard tenantId={tenantId} />}
      {page === 'applications' && (
        <section>
          <h2>{labels.applications}</h2>
          {entry.canApply && <button onClick={() => setApply(true)}>{labels.apply}</button>}
          {apply && <TransferApplication tenantId={tenantId} initiator="manager" />}
        </section>
      )}
      {page === 'reporting' && entry.canViewReporting && <ReadList tenantId={tenantId} path="reporting" />}
    </section>
  );
}
function useManagerData(tenantId: string, path: string) {
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    void transferRequest<Result>(tenantId, `${TRANSFER_API}/manager/${path}`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(requestError(cause));
      });
    return () => controller.abort();
  }, [tenantId, path]);
  return { data, error };
}
function Dashboard({ tenantId }: { tenantId: string }) {
  const { data, error } = useManagerData(tenantId, 'team?pageSize=1');
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('pending');
  return (
    <>
      <section>
        <h2>{labels.team}</h2>
        {error && <p role="alert">{error}</p>}
        <div className="transfer-actions">
          {Object.entries(labels.categories).map(([key, name]) => (
            <button key={key} onClick={() => setCategory(key)}>
              {name}：{data?.counts?.[key] ?? '—'}
            </button>
          ))}
        </div>
      </section>
      {category && (
        <section role="dialog" aria-label={labels.categories[category as keyof typeof labels.categories]}>
          <h3>{labels.categories[category as keyof typeof labels.categories]}</h3>
          <button onClick={() => setCategory(null)}>{labels.close}</button>
          <ReadList key={category} tenantId={tenantId} path={`team?category=${category}`} />
        </section>
      )}
      <section>
        <h2>{labels.search}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query.trim());
          }}
        >
          <input
            aria-label={labels.query}
            placeholder={labels.query}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit">{text.search}</button>
        </form>
        {search && <ReadList key={search} tenantId={tenantId} path={`search?search=${encodeURIComponent(search)}`} />}
      </section>
      <section>
        <div role="tablist" className="transfer-actions">
          {(['pending', 'processed', 'initiated'] as const).map((key) => (
            <button key={key} role="tab" aria-selected={key === tab} onClick={() => setTab(key)}>
              {labels[key]}
            </button>
          ))}
        </div>
        <ReadList key={tab} tenantId={tenantId} path={`todos?tab=${tab}`} todos />
      </section>
      {labels.placeholders.map((name) => (
        <section key={name}>
          <h2>{name}</h2>
          <p>{labels.placeholder}</p>
        </section>
      ))}
    </>
  );
}
function ReadList({ tenantId, path, todos = false }: { tenantId: string; path: string; todos?: boolean }) {
  const [page, setPage] = useState(1);
  const { data, error } = useManagerData(tenantId, `${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=50`);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p role="status">{text.loading}</p>;
  return (
    <>
      {data.items.length ? (
        todos ? (
          <ul>
            {data.items.map((row, index) => (
              <li key={String(row.id ?? row.taskId ?? index)}>
                {String(row.title)} ·{' '}
                {labels.statuses[String(row.status) as keyof typeof labels.statuses] ?? String(row.nodeName ?? '')}
              </li>
            ))}
          </ul>
        ) : (
          <EmploymentList
            items={data.items}
            columns={Object.entries(labels.columns).map(([key, label]) => ({ key, label }))}
            renderCell={(row, key) => displayCell(row, key, tenantId)}
          />
        )
      ) : (
        <p>{labels.empty}</p>
      )}
      <div className="transfer-actions">
        <button disabled={page === 1} onClick={() => setPage(page - 1)}>
          {text.previous}
        </button>
        <button disabled={data.items.length < 50} onClick={() => setPage(page + 1)}>
          {text.next}
        </button>
      </div>
    </>
  );
}

function avatarReference(value: unknown): AvatarReference | null {
  if (!value || typeof value !== 'object' || !('id' in value) || !('url' in value)) return null;
  return typeof value.id === 'string' && typeof value.url === 'string' ? { id: value.id, url: value.url } : null;
}

function displayCell(row: Row, key: string, tenantId: string) {
  const display = row.display && typeof row.display === 'object' ? row.display : row;
  const value = key === 'tenure' ? row.tenure : display[key];
  if (value == null) return '—';
  if (key === 'name')
    return (
      <span className="person-avatar-name">
        <PersonAvatar tenantId={tenantId} name={String(value)} avatar={avatarReference(row.avatar)} size={32} />
        {String(value)}
      </span>
    );
  if (key === 'leaving') return value ? labels.leavingYes : labels.leavingNo;
  if (key === 'employeeStatus') return labels.employeeStatuses[String(value)] ?? String(value);
  if (key === 'entryStatus') return labels.entryStatuses[String(value)] ?? String(value);
  if (key === 'employType')
    return labels.employTypes[String(value) as keyof typeof labels.employTypes] ?? String(value);
  return String(value);
}
