import { TransferPage } from './transfer/TransferPage.js';
import { EmployeePage } from './employee-self-service/EmployeePage.js';

export function App() {
  return window.location.pathname.startsWith('/self') ? <EmployeePage /> : <TransferPage />;
}
