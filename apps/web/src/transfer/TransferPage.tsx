import { useSession } from '../foundation/Session.js';
import { TransferApplication } from '../self-service/shared/TransferApplication.js';
import { useState } from 'react';
import { initialTenantId } from '../demo/tenant.js';
import { text } from './messages.js';
import './transfer.css';
import { HrTransferPage } from './HrTransferPage.js';

export function TransferPage({ initiator = 'hr' }: { initiator?: 'hr' | 'employee' | 'manager' }) {
  return initiator === 'hr' ? <HrTransferPage /> : <LegacyTransferPage initiator={initiator} />;
}

function LegacyTransferPage({ initiator }: { initiator: 'employee' | 'manager' }) {
  const session = useSession();
  const initialTenant = () => session.tenantId || initialTenantId();
  const [tenantId, setTenantId] = useState(initialTenant);
  const [activeTenant, setActiveTenant] = useState(initialTenant);
  return (
    <main className="transfer-page">
      <header className="transfer-header">
        <span className="transfer-brand">iTalent</span>
        <h1>{initiator === 'employee' ? text.personalTitle : text.title}</h1>
        <a href={initiator === 'employee' ? '/' : '/self/transfers'}>
          {initiator === 'employee' ? text.hrEntry : text.personalEntry}
        </a>
      </header>
      {activeTenant ? (
        <>
          <button
            hidden={!!session.tenantId}
            className="transfer-tenant-change"
            type="button"
            onClick={() => setActiveTenant('')}
          >
            {text.tenantChange}
          </button>
          <TransferApplication key={activeTenant} tenantId={activeTenant} initiator={initiator} />
        </>
      ) : (
        <form
          className="transfer-tenant"
          onSubmit={(event) => {
            event.preventDefault();
            setActiveTenant(tenantId.trim());
          }}
        >
          <label>
            {text.tenant}
            <input
              name="tenantId"
              value={tenantId}
              required
              onChange={(event) => setTenantId(event.target.value)}
              autoComplete="off"
            />
          </label>
          <p>{text.tenantHint}</p>
          <button type="submit">{text.enter}</button>
        </form>
      )}
    </main>
  );
}

export { TransferApplication as TransferManager } from '../self-service/shared/TransferApplication.js';
