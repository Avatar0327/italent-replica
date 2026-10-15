import type { ApplicationCommandRunner } from './application-command.js';
import { useState } from 'react';
import { LinkagePanel } from '../../transfer/LinkagePanel.js';
import { useLinkageDetail } from '../../transfer/useLinkage.js';
import { HrTransferForm } from '../../transfer/HrTransferForm.js';
import type { HrFormMode } from '../../transfer/hr-form-model.js';
import type { TransferAction, TransferFormProps } from '../../transfer/types.js';
import { TransferForm } from './TransferForm.js';
import { text } from '../../transfer/messages.js';
import { CommandStatus } from '../../foundation/forms/CommandStatus.js';
import { fieldLabels } from '../../transfer/hr-conflict.js';
import { useTransferForm } from './useTransferForm.js';
type TransferApplicationProps = {
  tenantId: string;
  initiator: 'hr' | 'employee' | 'manager';
  hrScope?: string;
  runCommand?: ApplicationCommandRunner;
  /** HR 调动管理全页表单：按入口（他人调动申请 / 调动）与写权限决定区块与按钮；员工、经理入口不传。 */
  hrForm?: { mode: HrFormMode; writable: boolean; onCancel: () => void };
};
export function TransferApplication(props: TransferApplicationProps) {
  const { tenantId, initiator, runCommand, hrScope, hrForm } = props;
  const state = useTransferForm(tenantId, initiator, undefined, runCommand, hrScope, hrForm?.mode === 'apply');
  if (hrScope && state.processing) return <p role="status">{text.processing}</p>;
  if (hrScope && state.saved) return <p role="status">{state.commandNotice}</p>;
  const restoring = state.draft.status === 'loading';
  const locked = state.busy || restoring || !!state.saved || !!state.unknownCommand;
  return (
    <section className="transfer-content" aria-busy={state.busy || state.loadingPreview}>
      {initiator !== 'employee' ? (
        <EmployeeSearch state={state} locked={locked} />
      ) : (
        <PersonalScenarios state={state} locked={locked} />
      )}
      <Notices state={state} locked={locked} />
      {state.loadingPreview && <p role="status">{text.loading}</p>}
      {!state.model.employees.length && state.model.catalog.today && <p>{text.noEmployees}</p>}
      <FormBody
        hrForm={hrForm}
        model={state.model}
        busy={locked}
        actionsDisabled={state.loadingPreview || restoring || !!state.model.typeConfirmation}
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
      {state.conflict && <CommandStatus submission={state.conflict} labels={fieldLabels(state.model.preview)} />}
      <CommandRecovery state={state} />
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
            <button type="button" disabled={state.busy || state.needsReload} onClick={state.reset}>
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

type FormState = ReturnType<typeof useTransferForm>;
function Notices({ state, locked }: { state: FormState; locked: boolean }) {
  return (
    <>
      {(state.commandError || state.error) && (
        <p role="alert" className="transfer-error">
          {state.commandError || state.error}
        </p>
      )}
      {state.model.typeConfirmation && (
        <p role="alert" className="transfer-error">
          {text.typeConfirmation}
        </p>
      )}
      <DraftBanner state={state} locked={locked} />
      {state.notice && (
        <p role="status" className="transfer-notice">
          {state.notice}
        </p>
      )}
    </>
  );
}
/** F-153（DEC-511）：原站选人后带出上次暂存，顶部提示可“点击清除”；读取失败时不带出，表单照常可填。 */
function DraftBanner({ state, locked }: { state: FormState; locked: boolean }) {
  if (state.draft.status === 'failed')
    return (
      <p role="alert" className="transfer-error">
        {text.draftRestoreFailed}
      </p>
    );
  if (state.draft.status !== 'restored') return null;
  return (
    <p role="status" className="transfer-notice">
      {text.draftRestored}{' '}
      <button type="button" className="transfer-link" disabled={locked} onClick={state.draft.clear}>
        {text.clearDraft}
      </button>
    </p>
  );
}

/** HR 入口按区块与入口按钮渲染；写权限不足时连 onAction 也不转发，避免绕过按钮禁用发出写请求。 */
function FormBody({ hrForm, ...props }: TransferFormProps & { hrForm: TransferApplicationProps['hrForm'] }) {
  if (!hrForm) return <TransferForm {...props} />;
  const onAction = (action: TransferAction) => {
    if (hrForm.writable) props.onAction?.(action);
  };
  return <HrTransferForm {...props} {...hrForm} onAction={onAction} />;
}

function CommandRecovery({ state }: { state: ReturnType<typeof useTransferForm> }) {
  return (
    <>
      {' '}
      {state.unknownCommand && (
        <p>
          {state.error !== text.unknown && text.unknown}
          <br />
          {text.requestReference}：<code>{state.unknownCommand}</code>
        </p>
      )}
    </>
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
