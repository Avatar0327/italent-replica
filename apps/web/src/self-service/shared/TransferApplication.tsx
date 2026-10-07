import { useState } from 'react';
import { LinkagePanel } from '../../transfer/LinkagePanel.js';
import { useLinkageDetail } from '../../transfer/useLinkage.js';
import { TransferForm } from './TransferForm.js';
import { text } from '../../transfer/messages.js';
import { useTransferForm } from './useTransferForm.js';
type TransferApplicationProps = { tenantId: string; initiator: 'hr' | 'employee' | 'manager' };
export function TransferApplication({ tenantId, initiator }: TransferApplicationProps) {
  const state = useTransferForm(tenantId, initiator);
  const locked = state.busy || !!state.saved || !!state.unknownCommand;
  return (
    <section className="transfer-content" aria-busy={state.busy || state.loadingPreview}>
      {initiator !== 'employee' ? (
        <EmployeeSearch state={state} locked={locked} />
      ) : (
        <PersonalScenarios state={state} locked={locked} />
      )}
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
        onLinkage={state.linkage}
        onWithEstablishment={state.withEstablishment}
        onAction={(action) => {
          void state.submit(action);
        }}
      />
      {state.saved && initiator === 'hr' && <LinkageDetail tenantId={tenantId} businessId={state.saved.id} />}
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
              disabled={state.busy || state.needsReload || state.loadingPreview}
              onClick={() => {
                void state.submit('submit');
              }}
            >
              {text.submitDraft}
            </button>
          )}
          {state.saved?.status === 'draft' && (
            <button
              type="button"
              disabled={state.busy}
              onClick={() => {
                void state.reloadSaved();
              }}
            >
              {text.reloadDraft}
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

function LinkageDetail({ tenantId, businessId }: { tenantId: string; businessId: string }) {
  const detail = useLinkageDetail(tenantId, businessId);
  return (
    <>
      {detail.error && (
        <p role="alert" className="transfer-error">
          {detail.error}
        </p>
      )}
      {detail.view && (
        <LinkagePanel
          view={detail.view}
          busy={detail.busy}
          onRetry={(item) => {
            void detail.retry(item);
          }}
        />
      )}
    </>
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

function PersonalScenarios({ state, locked }: { state: ReturnType<typeof useTransferForm>; locked: boolean }) {
  return (
    <nav aria-label={text.personalScenario} className="transfer-actions">
      {state.model.catalog.types.map((type) => (
        <button
          key={type.code}
          type="button"
          disabled={locked}
          aria-pressed={state.model.transferTypeCode === type.code}
          onClick={() => state.selection('transferTypeCode', type.code)}
        >
          {type.name}
        </button>
      ))}
    </nav>
  );
}
