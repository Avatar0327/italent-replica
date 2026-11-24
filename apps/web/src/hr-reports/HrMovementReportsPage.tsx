import { Navigate, NavLink, useLocation } from 'react-router';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { m } from './messages.js';
import { movementReports } from './model.js';
import { ReportView } from './ReportView.js';

const basePath = '/hr-movement-reports';

export function HrMovementReportsPage() {
  const path = useLocation().pathname.replace(/\/$/, '');
  if (path === basePath) return <Navigate to={`${basePath}/flow`} replace />;
  const report = movementReports.find(({ code }) => path === `${basePath}/${code}`);
  if (!report) return <PageState kind="not-found" />;
  return (
    <div className="hr-reports-page">
      <DecisionNote id="hr-movement-reports" />
      <nav aria-label={m.movementReports} className="hr-report-tabs">
        {movementReports.map(({ code, name }) => (
          <NavLink key={code} to={`${basePath}/${code}`} end>
            {name}
          </NavLink>
        ))}
      </nav>
      <ReportView report={report} />
    </div>
  );
}
