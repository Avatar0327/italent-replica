import { text as orgText } from './org/messages.js';
import { OrgChangePage } from './org/OrgChangePage.js';
import { ManagerPage } from './transfer/ManagerPage.js';
import { text as jobText } from './job/messages.js';
import { JobPage } from './job/JobPage.js';
import { TransferPage } from './transfer/TransferPage.js';
import { EmployeePage } from './employee-self-service/EmployeePage.js';

export function App() {
  if (window.location.pathname === '/org/changes') return <OrgChangePage />;
  if (window.location.pathname.startsWith('/self')) return <EmployeePage />;
  if (window.location.pathname.startsWith('/manager')) return <ManagerPage />;
  if (window.location.pathname === '/jobs') return <JobPage />;
  return (
    <>
      <nav>
        <a href="/org/changes">{orgText.title}</a>
        <a href="/jobs">{jobText.title}</a>
      </nav>
      <TransferPage />
    </>
  );
}
