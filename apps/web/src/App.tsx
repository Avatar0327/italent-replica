import { text as jobText } from './job/messages.js';
import { JobPage } from './job/JobPage.js';
import { TransferPage } from './transfer/TransferPage.js';

export function App() {
  if (window.location.pathname === '/jobs') return <JobPage />;
  return (
    <>
      <nav>
        <a href="/jobs">{jobText.title}</a>
      </nav>
      <TransferPage initiator={window.location.pathname === '/self/transfers' ? 'employee' : 'hr'} />
    </>
  );
}
