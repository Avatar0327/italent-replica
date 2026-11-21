import { useLocation } from 'react-router';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { reportOf } from '../hr-reports/model.js';
import { ReportView } from '../hr-reports/ReportView.js';
import { m } from './messages.js';

const roster = reportOf('roster')!;

export function HrAnalyticsRosterPage() {
  const { pathname } = useLocation();
  if (pathname.replace(/\/$/, '') !== '/hr-analytics-roster') return <PageState kind="not-found" />;
  return (
    <div className="hr-reports-page">
      <DecisionNote id="hr-analytics-roster" />
      <ReportView report={roster} title={m.rosterTitle} />
    </div>
  );
}
