import { useState, type ReactNode } from 'react';
import { initialTenantId } from '../../demo/tenant.js';
import { text } from '../../transfer/messages.js';
import '../../transfer/transfer.css';

/** 员工 / 经理页面只提供租户内内容；会话租户选择与刷新生命周期共用。 */
export function SelfServiceShell({ title, children }: { title: string; children: (tenantId: string) => ReactNode }) {
  const [tenantId, setTenantId] = useState(initialTenantId);
  const [activeTenant, setActiveTenant] = useState(initialTenantId);
  return (
    <main className="transfer-page">
      <header className="transfer-header">
        <span className="transfer-brand">iTalent</span>
        <h1>{title}</h1>
      </header>
      {activeTenant ? (
        <>
          <button type="button" className="transfer-tenant-change" onClick={() => setActiveTenant('')}>
            {text.tenantChange}
          </button>
          {children(activeTenant)}
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
              required
              value={tenantId}
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
