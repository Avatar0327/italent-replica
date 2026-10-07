import { ManagerPage } from './transfer/ManagerPage.js';
import { text as jobText } from './job/messages.js';
import { JobPage } from './job/JobPage.js';
import { TransferPage } from './transfer/TransferPage.js';
import { EmployeePage } from './employee-self-service/EmployeePage.js';
import { ApprovalPage } from './approval/ApprovalPage.js';

export function App() {
  if (window.location.pathname === '/approvals') return <ApprovalPage />;
  if (window.location.pathname.startsWith('/self')) return <EmployeePage />;
  if (window.location.pathname.startsWith('/manager')) return <ManagerPage />;
  if (window.location.pathname === '/jobs') return <JobPage />;
  return (
    <>
      <nav>
        <a href="/jobs">{jobText.title}</a>
      </nav>
      <TransferPage />
    </>
  );
}
