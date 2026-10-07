import { TransferApplication } from '../self-service/shared/TransferApplication.js';
import { useState } from 'react';
import { initialTenantId } from '../demo/tenant.js';
import { text } from './messages.js';
import './transfer.css';
import { normalizeUuid } from '@italent/domain';
import { approvalHref } from '../approval/navigation.js';
import { text as approvalText } from '../approval/messages.js';

export function TransferPage({ initiator = 'hr' }: { initiator?: 'hr' | 'employee' | 'manager' }) {
  const [tenantId, setTenantId] = useState(initialTenantId);
  const [activeTenant, setActiveTenant] = useState(initialTenantId);
  return (
    <main className="transfer-page">
      <header className="transfer-header">
        <span className="transfer-brand">iTalent</span>
        <h1>{initiator === 'employee' ? text.personalTitle : text.title}</h1>
        <a href={approvalHref({ tenantId: activeTenant })}>{approvalText.title}</a>
        <a href={initiator === 'employee' ? '/' : '/self/transfers'}>
          {initiator === 'employee' ? text.hrEntry : text.personalEntry}
        </a>
      </header>
      {activeTenant ? (
        <>
          <button className="transfer-tenant-change" type="button" onClick={() => setActiveTenant('')}>
            {text.tenantChange}
          </button>
          <TransferApplication key={activeTenant} tenantId={activeTenant} initiator={initiator} />
        </>
      ) : (
        <form
          className="transfer-tenant"
          onSubmit={(event) => {
            event.preventDefault();
            setActiveTenant(normalizeUuid(tenantId) ?? tenantId.trim());
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
