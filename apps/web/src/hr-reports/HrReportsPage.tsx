import { Alert, Button } from 'antd';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { m } from './messages.js';
import { base, reportOf, type CatalogItem } from './model.js';
import { ReportReadState } from './ReportReadState.js';
import { ReportView } from './ReportView.js';
import { useReportRead } from './useReportRead.js';

function Catalog() {
  const navigate = useNavigate();
  const [generation, refresh] = useState(0);
  const read = useReportRead<{ items: CatalogItem[] }>(base, generation);
  return (
    <section className="list-page">
      <header className="page-heading">
        <h1>{m.title}</h1>
      </header>
      <ReportReadState loading={read.loading} error={read.error} retry={() => refresh((n) => n + 1)} />
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
export function HrReportsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname.replace(/\/$/, '').split('/').slice(2);
  const code = path.length === 1 ? decodeURIComponent(path[0]!) : '';
  const report = reportOf(code);
  let content = <Alert type="error" message={m.missing} />;
  if (path.length === 0) content = <Catalog />;
  else if (report) content = <ReportView key={code} report={report} back={() => navigate('/hr-reports')} />;
  return (
    <div className="hr-reports-page">
      <DecisionNote id="hr-reports" />
      {content}
    </div>
  );
}
