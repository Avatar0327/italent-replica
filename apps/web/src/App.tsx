import { text as orgText } from './org/messages.js';
import { OrgChangePage } from './org/OrgChangePage.js';
import { TransferPage } from './transfer/TransferPage.js';

export function App() {
  if (window.location.pathname === '/org/changes') return <OrgChangePage />;
  return (
    <>
      <nav>
        <a href="/org/changes">{orgText.title}</a>
      </nav>
      <TransferPage initiator={window.location.pathname === '/self/transfers' ? 'employee' : 'hr'} />
    </>
  );
}
