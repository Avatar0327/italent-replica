import { useState } from 'react';
import { TransferForm } from './TransferForm.js';
import { text } from './messages.js';
import { useTransferForm } from './useTransferForm.js';
import './transfer.css';

export function TransferPage() {
  const [tenantId, setTenantId] = useState('');
  const [activeTenant, setActiveTenant] = useState('');
  return (
    <main className="transfer-page">
      <header className="transfer-header">
        <span className="transfer-brand">iTalent</span>
        <h1>{text.title}</h1>
      </header>
      {activeTenant ? (
        <>
          <button className="transfer-tenant-change" type="button" onClick={() => setActiveTenant('')}>
            {text.tenantChange}
          </button>
          <TransferManager key={activeTenant} tenantId={activeTenant} />
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

function TransferManager({ tenantId }: { tenantId: string }) {
  const state = useTransferForm(tenantId);
  const locked = state.busy || !!state.saved || !!state.unknownCommand;
  return (
    <section className="transfer-content" aria-busy={state.busy || state.loadingPreview}>
      <EmployeeSearch state={state} locked={locked} />
      {state.error && (
        <p role="alert" className="transfer-error">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p role="status" className="transfer-notice">
          {state.notice}
        </p>
      )}
      {state.loadingPreview && <p role="status">{text.loading}</p>}
      {!state.model.employees.length && state.model.catalog.today && <p>{text.noEmployees}</p>}
      <TransferForm
        model={state.model}
        busy={locked}
        actionsDisabled={state.loadingPreview}
        onSelection={state.selection}
        onField={state.field}
        onReferenceQuery={state.referenceQuery}
        onAction={(action) => {
          void state.submit(action);
        }}
      />
      {state.unknownCommand && (
        <p>
          {text.requestReference}：<code>{state.unknownCommand}</code>
        </p>
      )}
      {!state.unknownCommand && (
        <div className="transfer-actions">
          {state.saved?.status === 'draft' && (
            <button
              type="button"
              disabled={state.busy}
              onClick={() => {
                void state.submit('submit');
              }}
            >
              {text.submitDraft}
            </button>
          )}
          {state.saved ? (
            <button type="button" disabled={state.busy} onClick={state.reset}>
              {text.newApplication}
            </button>
          ) : (
            <button type="button" disabled={state.busy || state.loadingPreview} onClick={state.refresh}>
              {text.refresh}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function EmployeeSearch({ state, locked }: { state: ReturnType<typeof useTransferForm>; locked: boolean }) {
  const [search, setSearch] = useState('');
  return (
    <div className="transfer-search">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          state.search(search);
        }}
      >
        <input
          aria-label={text.employeeSearch}
          placeholder={text.employeeSearch}
          value={search}
          disabled={locked}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button type="submit" disabled={locked}>
          {text.search}
        </button>
      </form>
      <button type="button" disabled={locked || state.page === 1} onClick={() => state.setPage(state.page - 1)}>
        {text.previous}
      </button>
      <button
        type="button"
        disabled={locked || state.model.employees.length < 50}
        onClick={() => state.setPage(state.page + 1)}
      >
        {text.next}
      </button>
    </div>
  );
}
