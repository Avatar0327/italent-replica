import { useEffect, useMemo } from 'react';
import { TransferForm, useTransferForm } from '../self-service/shared/index.js';
import { employeeTransferAdapter } from './transfer-adapter.js';
import type { Profile } from './types.js';
import { text } from './messages.js';

export function EmployeeTransfer({
  tenantId,
  profile,
  onSaved,
}: {
  tenantId: string;
  profile: Profile;
  onSaved: () => void;
}) {
  const adapter = useMemo(() => employeeTransferAdapter(profile), [profile]);
  const state = useTransferForm(tenantId, 'employee', adapter);
  useEffect(() => {
    if (state.saved) onSaved();
  }, [state.saved, onSaved]);
  return (
    <section className="employee-transfer" aria-busy={state.busy || state.loadingPreview}>
      {state.error && <p role="alert">{state.error}</p>}
      {state.unknownCommand && (
        <p role="alert">
          {text.unknown}
          {state.unknownCommand}
        </p>
      )}
      {state.loadingPreview && <p role="status">{text.loading}</p>}
      {state.model.preview && (
        <TransferForm
          model={state.model}
          submitOnly
          busy={state.busy || !!state.unknownCommand || !!state.saved}
          actionsDisabled={state.loadingPreview}
          onSelection={state.selection}
          onField={state.field}
          onAction={() => {
            void state.submit('submit');
          }}
          onReferenceQuery={state.referenceQuery}
        />
      )}
      <p>{text.referenceBoundary}</p>
      <fieldset disabled>
        <legend>{text.partTime}</legend>
        <p>{text.partTimeHint}</p>
      </fieldset>
    </section>
  );
}
