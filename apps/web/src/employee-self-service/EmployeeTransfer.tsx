import { useEffect, useRef, useState } from 'react';
import { TransferForm } from '../transfer/TransferForm.js';
import { transferRequest, requestError, TransferApiError } from '../transfer/api.js';
import type { Choice, FieldValues, TransferFormModel } from '../transfer/types.js';
import type { OwnPreview, Profile } from './types.js';
import { text } from './messages.js';

const BASE = '/api/tenant/self-service';
export function EmployeeTransfer({
  tenantId,
  profile,
  onSaved,
}: {
  tenantId: string;
  profile: Profile;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(profile.today);
  const [reason, setReason] = useState('');
  const [fields, setFields] = useState<FieldValues>({});
  const [customFields, setCustomFields] = useState<FieldValues>({});
  const [error, setError] = useState('');
  const body = JSON.stringify({ effectiveDate: date, ...(reason ? { reasonCode: reason } : {}), fields, customFields });
  const { preview, setPreview, references, setReferences, loading } = useOwnPreview(tenantId, body, setError);
  const { busy, unknown, submit } = useSubmit(tenantId, body, preview, loading, setPreview, setError, onSaved);
  const model = formModel(profile, date, reason, fields, customFields, preview, references);
  return (
    <section className="employee-transfer" aria-busy={busy || loading}>
      {error && <p role="alert">{error}</p>}
      {unknown && (
        <p role="alert">
          {text.unknown}
          {unknown}
        </p>
      )}
      {loading && <p role="status">{text.loading}</p>}
      {preview && (
        <TransferForm
          model={model}
          submitOnly
          busy={busy || !!unknown}
          actionsDisabled={loading}
          onSelection={(field, value) => {
            if (field === 'effectiveDate') {
              setDate(value);
              setReferences({});
            }
            if (field === 'reasonCode') setReason(value);
          }}
          onField={(source, code, value) =>
            (source === 'preset' ? setFields : setCustomFields)((old) => {
              const next = { ...old, [code]: value };
              if (source === 'preset' && code === 'departmentId') delete next.directManagerId;
              if (source === 'preset' && code === 'postId') delete next.sequenceId;
              return next;
            })
          }
          onAction={() => {
            void submit();
          }}
          onReferenceQuery={referenceQuery(tenantId, date, setReferences, setError)}
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
function useOwnPreview(tenantId: string, body: string, setError: (value: string) => void) {
  const [preview, setPreview] = useState<OwnPreview | null>(null);
  const [references, setReferences] = useState<Record<string, Choice[]>>({});
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setLoading(true);
    const timer = setTimeout(() => {
      void transferRequest<OwnPreview>(tenantId, `${BASE}/transfer/preview`, {
        method: 'POST',
        body,
        signal: controller.signal,
      })
        .then(async (result) => {
          const choices = await loadChoices(tenantId, body, result, controller.signal);
          if (controller.signal.aborted) return;
          setReferences(Object.fromEntries(choices));
          setPreview(result);
          setError('');
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(requestError(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tenantId, body]);
  return { preview, setPreview, references, setReferences, loading };
}
async function loadChoices(tenantId: string, body: string, result: OwnPreview, signal: AbortSignal) {
  const referenceCodes = [
    'departmentId',
    'directManagerId',
    'dottedManagerId',
    'addedSubordinateIds',
    'postId',
    'positionId',
    'levelId',
    'gradeId',
    'sequenceId',
    'professionalLineId',
  ];
  const choices = await Promise.all(
    referenceCodes
      .filter((code) => result.form.fieldModes[`preset:${code}`])
      .map(async (code) => {
        const query = new URLSearchParams({ asOf: JSON.parse(body).effectiveDate as string, pageSize: '100' });
        const list = await transferRequest<{ items: Choice[] }>(
          tenantId,
          `${BASE}/transfer/references/${code}?${query}`,
          { signal: signal },
        );
        return [code, list.items] as const;
      }),
  );
  return choices;
}
function formModel(
  profile: Profile,
  date: string,
  reason: string,
  fields: FieldValues,
  customFields: FieldValues,
  preview: OwnPreview | null,
  references: Record<string, Choice[]>,
): TransferFormModel {
  const originals: Record<string, Choice[]> = {};
  for (const [code, name] of Object.entries(preview?.beforeLabels ?? {})) {
    const id = preview?.before?.fields[code];
    if (typeof id === 'string') originals[code] = [{ id, name }];
  }
  const currentReferences = { ...references };
  for (const [code, name] of Object.entries(preview?.valueLabels ?? {})) {
    const id = preview?.fields[code];
    if (typeof id === 'string' && !currentReferences[code]?.some((item) => item.id === id))
      currentReferences[code] = [{ id, name }, ...(currentReferences[code] ?? [])];
  }
  return {
    initiator: 'employee',
    employees: [profile.employee],
    employeeId: profile.employee.id,
    effectiveDate: date,
    reasonCode: reason,
    transferTypeCode: 'in_department',
    fields,
    customFields,
    preview,
    departments: currentReferences.departmentId ?? [],
    references: currentReferences,
    beforeReferences: originals,
    catalog: { types: [], reasons: preview?.reasons ?? [] },
  };
}
function useSubmit(
  tenantId: string,
  body: string,
  preview: OwnPreview | null,
  loading: boolean,
  setPreview: (value: OwnPreview | null) => void,
  setError: (value: string) => void,
  onSaved: () => void,
) {
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState('');
  const saving = useRef(false);
  const submit = async () => {
    if (!preview || loading || saving.current || unknown) return;
    saving.current = true;
    setBusy(true);
    const command = crypto.randomUUID();
    try {
      await transferRequest(tenantId, `${BASE}/transfer`, {
        method: 'POST',
        body,
        headers: { 'if-match': String(preview.employeeRevision), 'idempotency-key': command },
      });
      onSaved();
    } catch (cause) {
      if (!(cause instanceof TransferApiError) || cause.status >= 500) setUnknown(command);
      else setError(requestError(cause));
      if (cause instanceof TransferApiError && cause.code === 'REVISION_CONFLICT') setPreview(null);
    } finally {
      setBusy(false);
      saving.current = false;
    }
  };
  return { submit, busy, unknown };
}

function referenceQuery(
  tenantId: string,
  date: string,
  setReferences: React.Dispatch<React.SetStateAction<Record<string, Choice[]>>>,
  setError: (value: string) => void,
) {
  return async (code: string, name: string, page: number) => {
    try {
      const query = new URLSearchParams({ asOf: date, name, page: String(page), pageSize: '100' });
      const result = await transferRequest<{ items: Choice[] }>(
        tenantId,
        `${BASE}/transfer/references/${code}?${query}`,
      );
      setReferences((old) => ({ ...old, [code]: result.items }));
    } catch (cause) {
      setError(requestError(cause));
    }
  };
}
