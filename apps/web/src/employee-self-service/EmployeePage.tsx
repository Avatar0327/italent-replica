import { SelfServiceShell, EmploymentList as SharedEmploymentList } from '../self-service/shared/index.js';
import { useEffect, useState } from 'react';
import { requestError, transferRequest } from '../transfer/api.js';
import { presetLabels } from '../transfer/messages.js';
import { EmployeeTransfer } from './EmployeeTransfer.js';
import { text } from './messages.js';
import type { Application, OwnRecord, Profile } from './types.js';
import '../transfer/transfer.css';
import './employee.css';
import { PersonAvatar } from '../shared/PersonAvatar.js';
import { accountText } from '../account/messages.js';

const BASE = '/api/tenant/self-service';
export function EmployeePage() {
  return (
    <SelfServiceShell title={text.title}>
      {(tenantId) => <Workspace key={tenantId} tenantId={tenantId} />}
    </SelfServiceShell>
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
  const fields = ['departmentId', 'positionId', 'postId'].filter((code) =>
    records.some((row) => Object.hasOwn(row.fields, code)),
  );
  const columns = [
    { key: 'name', label: text.name },
    ...fields.map((key) => ({ key, label: presetLabels[key]! })),
    { key: 'effectiveDate', label: text.start },
    { key: 'stopDate', label: text.end },
    { key: 'approvalStatus', label: text.approval },
  ];
  const items = records.map((record) => ({
    id: record.id,
    name,
    effectiveDate: record.effectiveDate,
    stopDate: record.stopDate,
    approvalStatus: record.approvalStatus,
    ...Object.fromEntries(fields.map((code) => [code, display(record, code)])),
  }));
  return (
    <div className="employee-table">
      <SharedEmploymentList items={items} columns={columns} />
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
  const columns = [
    { key: 'title', label: text.applicationTitle },
    { key: 'category', label: text.category },
    { key: 'initiator', label: text.initiator },
    { key: 'currentHandlers', label: text.handlers },
    { key: 'status', label: text.approval },
    { key: 'reason', label: text.reason },
    { key: 'createdAt', label: text.submittedAt },
  ];
  const items = applications.map((item) => ({
    ...item,
    currentHandlers: item.currentHandlers.join('、') || text.none,
    reason: item.reason || text.none,
  }));
  return (
    <div className="employee-table">
      <SharedEmploymentList
        items={items}
        columns={columns}
        renderCell={(item, key) =>
          key === 'title' ? (
            <button
              className="employee-title-link"
              onClick={() => onDetail?.(applications.find((row) => row.id === item.id)!)}
            >
              {item.title}
            </button>
          ) : key === 'createdAt' ? (
            <time dateTime={item.createdAt}>
              {new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: timezone })}
            </time>
          ) : (
            String(item[key as keyof typeof item] ?? text.none)
          )
        }
      />
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
          <h2 className="person-avatar-heading">
            <PersonAvatar tenantId={tenantId} name={profile.employee.name} avatar={profile.employee.avatar} />
            {profile.employee.name}
          </h2>
          <a href="/account">{accountText.title}</a>
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
