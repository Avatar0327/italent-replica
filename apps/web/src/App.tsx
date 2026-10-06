import { ManagerPage } from './transfer/ManagerPage.js';
import { TransferPage } from './transfer/TransferPage.js';

export function App() {
  if (window.location.pathname.startsWith('/manager')) return <ManagerPage />;
  return <TransferPage initiator={window.location.pathname === '/self/transfers' ? 'employee' : 'hr'} />;
}
