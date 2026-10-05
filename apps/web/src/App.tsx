import { TransferPage } from './transfer/TransferPage.js';

export function App() {
  return <TransferPage initiator={window.location.pathname === '/self/transfers' ? 'employee' : 'hr'} />;
}
