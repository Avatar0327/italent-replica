import { Alert, Button, Space, Spin } from 'antd';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { PersonnelReport } from '@italent/domain';
import { useSession } from '../foundation/Session.js';
import { usePermissions } from '../foundation/Permissions.js';
import { tenantDate } from '../foundation/dates.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { descriptions, m } from './messages.js';
import {
  base,
  errorText,
  initialFilters,
  movement,
  reportOf,
  reportUrl,
  statistical,
  type CatalogItem,
  type Filters,
  type ReportData,
} from './model.js';
import { useReportRead } from './useReportRead.js';
import { ReportFilters } from './ReportFilters.js';
import { ReportTable } from './ReportTable.js';
import { ReportExport } from './ReportExport.js';
import './hr-reports.css';

function ReadState({ loading, error, retry }: { loading: boolean; error?: unknown; retry(): void }) {
  if (loading)
    return (
      <div role="status">
        <Spin /> {m.loading}
      </div>
    );
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        message={errorText(error)}
        role="alert"
        action={<Button onClick={retry}>{m.retry}</Button>}
      />
    );
  return null;
}
function Catalog() {
  const navigate = useNavigate();
  const [generation, refresh] = useState(0);
  const read = useReportRead<{ items: CatalogItem[] }>(base, generation);
  return (
    <section className="list-page">
      <header className="page-heading">
        <h1>{m.title}</h1>
      </header>
      <ReadState {...read} retry={() => refresh((n) => n + 1)} />
      {read.data && (
        <div className="list-card hr-report-catalog">
          {(['员工名册分析', '人事报表', '员工花名册'] as const).map((group) => (
            <section key={group}>
              <h2>{group}</h2>
              <ul>
                {read
                  .data!.items.filter((r) => r.group === group)
                  .map((report) => (
                    <li key={report.code}>
                      <Button
                        type="link"
                        disabled={!report.available}
                        onClick={() => navigate(`/hr-reports/${encodeURIComponent(report.code)}`)}
                      >
                        {report.name}
                      </Button>
                      {!report.available && <span>{report.reason || m.unavailable}</span>}
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
function ReportView({ report }: { report: PersonnelReport }) {
  const session = useSession();
  const permission = usePermissions('TenantBase.HrRoster');
  const today = session.today ?? tenantDate(new Date(), session.timezone);
  const [initial] = useState(() => initialFilters(report.code, today));
  const [query, setQuery] = useState({ filters: initial, page: 1, generation: 0 });
  const navigate = useNavigate();
  const read = useReportRead<ReportData>(reportUrl(report, query.filters, query.page), query.generation);
  const apply = (filters: Filters) => setQuery({ filters, page: 1, generation: query.generation + 1 });
  const columns = read.data && 'items' in read.data ? read.data.columns : [];
  return (
    <section className="list-page">
      <header className="page-heading">
        <h1>{report.name}</h1>
        <Space>
          <Button onClick={() => navigate('/hr-reports')}>{m.back}</Button>
          {!statistical(report.code) &&
            read.data &&
            !permission.loading &&
            !permission.error &&
            permission.can('export', 'list') && (
              <ReportExport key={JSON.stringify(query)} report={report} filters={query.filters} />
            )}
        </Space>
      </header>
      <div className="list-card hr-report-content">
        <p>{descriptions[report.code]}</p>
        {movement(report.code) && <p>{m.movementHint}</p>}
        <ReportFilters code={report.code} initial={initial} columns={columns} busy={read.loading} apply={apply} />
        <ReadState {...read} retry={() => setQuery({ ...query, generation: query.generation + 1 })} />
        {read.data && (
          <>
            {read.data.hasDataPermission === false && <Alert type="info" message={m.noScope} />}
            <ReportTable
              code={report.code}
              data={read.data}
              page={query.page}
              changePage={(page) => setQuery({ ...query, page })}
            />
          </>
        )}
      </div>
    </section>
  );
}
export function HrReportsPage() {
  const location = useLocation();
  const session = useSession();
  const path = location.pathname.replace(/\/$/, '').split('/').slice(2);
  const code = path.length === 1 ? decodeURIComponent(path[0]!) : '';
  const report = reportOf(code);
  let content = <Alert type="error" message={m.missing} />;
  if (path.length === 0) content = <Catalog />;
  else if (report) content = <ReportView key={`${session.tenantId}/${session.identityKey}/${code}`} report={report} />;
  return (
    <div className="hr-reports-page">
      <DecisionNote id="hr-reports" />
      {content}
    </div>
  );
}
