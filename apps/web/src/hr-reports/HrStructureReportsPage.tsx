import { Navigate, NavLink, useLocation } from 'react-router';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { m } from './messages.js';
import { structureReports } from './model.js';
import { ReportView } from './ReportView.js';

const basePath = '/hr-structure-reports';

export function HrStructureReportsPage() {
  const { pathname } = useLocation();
  const path = pathname.replace(/\/$/, '');
  if (path === basePath) return <Navigate to={`${basePath}/quality`} replace />;
  const report = structureReports.find(({ code }) => path === `${basePath}/${code}`);
  if (!report) return <PageState kind="not-found" />;
  return (
    <div className="hr-reports-page">
      <DecisionNote id="hr-structure-reports" />
      <nav aria-label={m.structureReports} className="hr-report-tabs">
        {structureReports.map(({ code, name }) => (
          <NavLink key={code} to={`${basePath}/${code}`} end>
            {name}
          </NavLink>
        ))}
      </nav>
      <ReportView report={report} />
    </div>
  );
}
