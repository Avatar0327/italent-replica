import { useEffect, useState } from 'react';
import { requestError, transferRequest } from '../transfer/api.js';
import { presetLabels } from '../transfer/messages.js';
import { EmployeeTransfer } from './EmployeeTransfer.js';
import { text } from './messages.js';
import type { Application, OwnRecord, Profile } from './types.js';
import '../transfer/transfer.css';
import './employee.css';

const BASE = '/api/tenant/self-service';
export function EmployeePage() {
  const [tenant, setTenant] = useState('');
  const [active, setActive] = useState('');
  return (
    <main className="transfer-page employee-page">
      <header className="transfer-header">
        <span className="transfer-brand">iTalent</span>
        <h1>{text.title}</h1>
      </header>
      {active ? (
        <>
          <button onClick={() => setActive('')}>{text.changeTenant}</button>
          <Workspace key={active} tenantId={active} />
        </>
      ) : (
        <form
          className="transfer-tenant"
          onSubmit={(event) => {
            event.preventDefault();
            setActive(tenant.trim());
          }}
        >
          <label>
            {text.tenant}
            <input required value={tenant} onChange={(event) => setTenant(event.target.value)} />
          </label>
          <button type="submit">{text.enter}</button>
        </form>
      )}
    </main>
  );
}

function useWorkspace(tenantId: string) {
  const [tab, setTab] = useState<'profile' | 'records' | 'applications'>('profile');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [records, setRecords] = useState<OwnRecord[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [detail, setDetail] = useState<OwnRecord | null>(null);
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [form, setForm] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setProfile(null);
    setRecords([]);
    setApplications([]);
    setDetail(null);
    void (async () => {
      const own = await transferRequest<Profile>(tenantId, `${BASE}/profile`, { signal: controller.signal });
      const suffix = `?page=${page}&pageSize=20`;
      const rows =
        tab === 'profile'
          ? null
          : await transferRequest<{ items: OwnRecord[] | Application[] }>(
              tenantId,
              tab === 'records'
                ? `${BASE}/employees/${own.employee.id}/records${suffix}`
                : `${BASE}/applications${suffix}`,
              { signal: controller.signal },
            );
      if (controller.signal.aborted) return;
      setProfile(own);
      if (tab === 'records') setRecords((rows?.items ?? []) as OwnRecord[]);
      if (tab === 'applications') setApplications((rows?.items ?? []) as Application[]);
    })()
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(requestError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tenantId, tab, page, reload]);
  return {
    tab,
    setTab,
    profile,
    records,
    applications,
    detail,
    setDetail,
    page,
    setPage,
    setReload,
    form,
    setForm,
    error,
    setError,
    notice,
    setNotice,
    loading,
  };
}
function Workspace({ tenantId }: { tenantId: string }) {
  const state = useWorkspace(tenantId);
  const { tab, setTab, records, applications, page, setPage, setReload, setForm, error, notice, loading } = state;
  return (
    <section className="transfer-content" aria-busy={loading}>
      <nav className="employee-tabs">
        {(['profile', 'records', 'applications'] as const).map((key) => (
          <button
            key={key}
            aria-pressed={tab === key}
            onClick={() => {
              setTab(key);
              setPage(1);
              setForm(false);
            }}
          >
            {text[key]}
          </button>
        ))}
      </nav>
      <button
        disabled={loading}
        onClick={() => {
          setReload((v) => v + 1);
          setForm(false);
        }}
      >
        {text.refresh}
      </button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">{text.loading}</p>}
      <WorkspaceContent tenantId={tenantId} state={state} />
      {tab !== 'profile' && (
        <div className="employee-pagination">
          <button disabled={page === 1 || loading} onClick={() => setPage(page - 1)}>
            {text.previous}
          </button>
          <span>{page}</span>
          <button
            disabled={loading || (tab === 'records' ? records : applications).length < 20}
            onClick={() => setPage(page + 1)}
          >
            {text.next}
          </button>
        </div>
      )}
    </section>
  );
}

function display(record: OwnRecord, code: string) {
  const value = record.fields[code];
  return record.fieldLabels[code] || (typeof value === 'string' && !/^[0-9a-f-]{36}$/i.test(value) ? value : text.none);
}
export function EmploymentList({ records, name }: { records: OwnRecord[]; name: string }) {
  const columns = ['departmentId', 'positionId', 'postId'].filter((code) =>
    records.some((row) => Object.hasOwn(row.fields, code)),
  );
  return (
    <div className="employee-table">
      <table>
        <thead>
          <tr>
            <th>{text.name}</th>
            {columns.map((code) => (
              <th key={code}>{presetLabels[code]}</th>
            ))}
            <th>{text.start}</th>
            <th>{text.end}</th>
            <th>{text.approval}</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id}>
              <td>{name}</td>
              {columns.map((code) => (
                <td key={code}>{display(record, code)}</td>
              ))}
              <td>{record.effectiveDate}</td>
              <td>{record.stopDate && record.stopDate !== '9999-12-31' ? record.stopDate : text.none}</td>
              <td>{record.approvalStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!records.length && <p>{text.empty}</p>}
    </div>
  );
}
export function RecordDetails({ record }: { record: OwnRecord }) {
  return (
    <dl className="employee-details">
      <dt>{text.start}</dt>
      <dd>{record.effectiveDate}</dd>
      {Object.keys(record.fields)
        .filter((code) => presetLabels[code])
        .map((code) => (
          <div key={code}>
            <dt>{presetLabels[code]}</dt>
            <dd>{display(record, code)}</dd>
          </div>
        ))}
    </dl>
  );
}

export function ApplicationList({
  applications,
  timezone = 'UTC',
  onDetail,
}: {
  applications: Application[];
  timezone?: string;
  onDetail?: (item: Application) => void;
}) {
  return (
    <div className="employee-table">
      <table>
        <thead>
          <tr>
            {[
              text.applicationTitle,
              text.category,
              text.initiator,
              text.handlers,
              text.approval,
              text.reason,
              text.submittedAt,
            ].map((label) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {applications.map((item) => (
            <tr key={item.id}>
              <td>
                <button className="employee-title-link" onClick={() => onDetail?.(item)}>
                  {item.title}
                </button>
              </td>
              <td>{item.category}</td>
              <td>{item.initiator}</td>
              <td>{item.currentHandlers.join('、') || text.none}</td>
              <td>{item.status}</td>
              <td>{item.reason || text.none}</td>
              <td>
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: timezone })}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!applications.length && <p>{text.empty}</p>}
    </div>
  );
}

function WorkspaceContent({ tenantId, state }: { tenantId: string; state: ReturnType<typeof useWorkspace> }) {
  const {
    profile,
    tab,
    form,
    setForm,
    setNotice,
    setTab,
    setPage,
    setReload,
    records,
    applications,
    setDetail,
    setError,
    detail,
  } = state;
  return (
    <>
      {profile && tab === 'profile' && (
        <>
          <h2>{profile.employee.name}</h2>
          <p>
            {text.code}：{profile.employee.code}
          </p>
          {profile.record ? <RecordDetails record={profile.record} /> : <p>{text.empty}</p>}
        </>
      )}
      {profile && tab === 'records' && (
        <>
          <p>{text.recordHint}</p>
          <button onClick={() => setForm(!form)}>{form ? text.close : text.transfer}</button>
          {form && (
            <EmployeeTransfer
              tenantId={tenantId}
              profile={profile}
              onSaved={() => {
                setForm(false);
                setNotice(text.submitted);
                setTab('applications');
                setPage(1);
                setReload((v) => v + 1);
              }}
            />
          )}
          <EmploymentList records={records} name={profile.employee.name} />
        </>
      )}
      {profile && tab === 'applications' && (
        <div>
          <ApplicationList
            applications={applications}
            timezone={profile.timezone}
            onDetail={(item) => {
              void transferRequest<{ record: OwnRecord }>(tenantId, `${BASE}/applications/${item.id}`)
                .then((result) => setDetail(result.record))
                .catch((cause: unknown) => setError(requestError(cause)));
            }}
          />
          {detail && (
            <section aria-label={text.detail}>
              <button onClick={() => setDetail(null)}>{text.close}</button>
              <RecordDetails record={detail} />
            </section>
          )}
        </div>
      )}
    </>
  );
}
