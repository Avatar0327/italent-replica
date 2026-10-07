import { useState, type ReactNode } from 'react';
import { initialTenantId as demoInitialTenantId } from '../../demo/tenant.js';
import { text } from '../../transfer/messages.js';
import '../../transfer/transfer.css';
import { normalizeUuid } from '@italent/domain';
import { approvalHref } from '../../approval/navigation.js';
import { text as approvalText } from '../../approval/messages.js';

/** 员工 / 经理页面只提供租户内内容；会话租户选择与刷新生命周期共用。 */
export function SelfServiceShell({
  title,
  children,
  initialTenantId = '',
}: {
  title: string;
  children: (tenantId: string) => ReactNode;
  initialTenantId?: string;
}) {
  const [tenantId, setTenantId] = useState(() => initialTenantId || demoInitialTenantId());
  const [activeTenant, setActiveTenant] = useState(() => {
    const demoTenantId = demoInitialTenantId();
    return demoTenantId ? initialTenantId || demoTenantId : '';
  });
  return (
    <main className="transfer-page">
      <header className="transfer-header">
        <span className="transfer-brand">iTalent</span>
        <h1>{title}</h1>
        <a href={approvalHref({ tenantId: activeTenant })}>{approvalText.title}</a>
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
            setActiveTenant(normalizeUuid(tenantId) ?? tenantId.trim());
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
