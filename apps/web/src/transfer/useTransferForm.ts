import { useEffect, useRef, useState } from 'react';
import { missingTransferRequiredFields } from '@italent/domain';
import {
  EMPLOYMENT_API,
  TRANSFER_API,
  loadReferences,
  previewInput,
  queryReferences,
  requestError,
  saveTransfer,
  submitSavedTransfer,
  transferRequest,
  TransferApiError,
} from './api.js';
import { text } from './messages.js';
import type {
  Choice,
  EmployeeChoice,
  FieldValue,
  TransferAction,
  TransferBusiness,
  TransferCatalog,
  TransferFormModel,
  TransferPreview,
} from './types.js';

const initial: TransferFormModel = {
  employees: [],
  departments: [],
  catalog: { types: [], reasons: [] },
  employeeId: '',
  effectiveDate: '',
  transferTypeCode: '',
  reasonCode: '',
  fields: {},
  customFields: {},
  preview: null,
};
export function useTransferForm(tenantId: string) {
  const [model, setModel] = useState(initial);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const commands = useTransferCommand(tenantId, model, loadingPreview, setModel, setError, setNotice);
  useCatalog(tenantId, model.effectiveDate, setModel, setError);
  useEmployees(tenantId, model.catalog.today, search, page, setModel, setError);
  usePreview(tenantId, model, reload, setModel, setLoadingPreview, setError, setNotice);
  const selection = (field: 'employeeId' | 'effectiveDate' | 'transferTypeCode' | 'reasonCode', value: string) => {
    setError('');
    setModel((current) =>
      field === 'reasonCode'
        ? { ...current, reasonCode: value }
        : {
            ...current,
            [field]: value,
            reasonCode: field === 'transferTypeCode' ? '' : current.reasonCode,
            fields: {},
            customFields: {},
            preview: null,
          },
    );
  };
  const field = (source: 'preset' | 'custom', code: string, value: FieldValue) => {
    const key = source === 'preset' ? 'fields' : 'customFields';
    setModel((current) => {
      const values = { ...current[key], [code]: value };
      if (source === 'preset' && code === 'postId') delete values.sequenceId;
      return { ...current, [key]: values };
    });
  };
  const refresh = () => {
    setError('');
    setModel((current) => ({ ...current, fields: {}, customFields: {}, preview: null }));
    setReload((value) => value + 1);
  };
  const reset = () => {
    commands.setSaved(null);
    setNotice('');
    refresh();
  };
  return {
    model,
    error,
    notice,
    ...commands,
    loadingPreview,
    page,
    selection,
    field,
    refresh,
    reset,
    setPage: (next: number) => {
      setPage(next);
      selection('employeeId', '');
    },
    referenceQuery: referenceQuery(tenantId, model, setModel, setError),
    search: (value: string) => {
      selection('employeeId', '');
      setSearch(value);
      setPage(1);
    },
  };
}

function useTransferCommand(
  tenantId: string,
  model: TransferFormModel,
  loadingPreview: boolean,
  setModel: SetModel,
  setError: SetText,
  setNotice: SetText,
) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<TransferBusiness | null>(null);
  const [unknownCommand, setUnknownCommand] = useState('');
  const requestInProgress = useRef(false);
  const submit = async (action: TransferAction) => {
    if (!model.preview || requestInProgress.current || unknownCommand || loadingPreview) return;
    if (missingTransferRequiredFields(model.preview.form, model.fields).length > 0) return;
    requestInProgress.current = true;
    setBusy(true);
    setError('');
    const commandId = crypto.randomUUID();
    try {
      const result = saved
        ? await submitSavedTransfer(tenantId, saved, commandId)
        : await saveTransfer(tenantId, model, action, commandId);
      if (!result.id || !Number.isInteger(result.revision) || !result.status) throw new Error(text.unknown);
      setSaved(result);
      setNotice(
        result.status === 'draft'
          ? text.draftSaved
          : action === 'direct'
            ? result.status === 'effective'
              ? text.effective
              : text.scheduled
            : text.submitted,
      );
    } catch (cause) {
      if (!(cause instanceof TransferApiError) || cause.status >= 500) {
        setUnknownCommand(commandId);
        setError(text.unknown);
      } else setError(requestError(cause));
      if (cause instanceof TransferApiError && cause.status === 409) {
        setModel((current) => ({ ...current, preview: null }));
      }
    } finally {
      setBusy(false);
      requestInProgress.current = false;
    }
  };
  return { busy, saved, unknownCommand, submit, setSaved };
}

type SetModel = React.Dispatch<React.SetStateAction<TransferFormModel>>;
type SetText = React.Dispatch<React.SetStateAction<string>>;
function useCatalog(tenantId: string, date: string, setModel: SetModel, setError: SetText) {
  useEffect(() => {
    const controller = new AbortController();
    const query = date ? `?effectiveDate=${encodeURIComponent(date)}` : '';
    void transferRequest<TransferCatalog>(tenantId, `${TRANSFER_API}/catalog${query}`, { signal: controller.signal })
      .then((catalog) => {
        if (controller.signal.aborted) return;
        setModel((current) => ({
          ...current,
          catalog,
          effectiveDate: current.effectiveDate || catalog.today || '',
          transferTypeCode: catalog.types.some((type) => type.code === current.transferTypeCode)
            ? current.transferTypeCode
            : (catalog.types[0]?.code ?? ''),
        }));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(requestError(cause));
      });
    return () => controller.abort();
  }, [tenantId, date, setModel, setError]);
}
function useEmployees(
  tenantId: string,
  today: string | undefined,
  search: string,
  page: number,
  setModel: SetModel,
  setError: SetText,
) {
  useEffect(() => {
    if (!today) return;
    const controller = new AbortController();
    const query = new URLSearchParams({
      asOf: today,
      status: 'employed',
      name: search,
      page: String(page),
      pageSize: '50',
    });
    void transferRequest<{ items: EmployeeChoice[] }>(tenantId, `${EMPLOYMENT_API}/employees?${query}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setModel((current) => ({ ...current, employees: result.items }));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(requestError(cause));
      });
    return () => controller.abort();
  }, [tenantId, today, search, page, setModel, setError]);
}
function usePreview(
  tenantId: string,
  model: TransferFormModel,
  reload: number,
  setModel: SetModel,
  setBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setError: SetText,
  setNotice: SetText,
) {
  const input = JSON.stringify(previewInput(model));
  useEffect(() => {
    if (!model.employeeId || !model.effectiveDate || !model.transferTypeCode) {
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      void loadPreview(tenantId, model, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setModel((current) => ({ ...current, ...result }));
          setNotice(result.unavailable ? text.referencesUnavailable : '');
          setError('');
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) {
            setError(requestError(cause));
            setModel((current) => ({ ...current, preview: null }));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // input covers the scalar selection and explicit edits; returned defaults never trigger another request.
  }, [tenantId, model.employeeId, input, reload, setModel, setBusy, setError, setNotice]);
}
async function loadPreview(tenantId: string, model: TransferFormModel, signal: AbortSignal) {
  const preview = await transferRequest<TransferPreview>(
    tenantId,
    `${TRANSFER_API}/employees/${model.employeeId}/preview`,
    { method: 'POST', body: JSON.stringify(previewInput(model)), signal },
  );
  const query = new URLSearchParams({ formId: preview.form.id, effectiveDate: model.effectiveDate, pageSize: '100' });
  const [departments, references] = await Promise.all([
    transferRequest<{ items: Choice[] }>(tenantId, `${TRANSFER_API}/departments?${query}`, { signal }),
    loadReferences(tenantId, preview, model, signal),
  ]);
  return { preview, departments: departments.items, ...references };
}

function referenceQuery(tenantId: string, model: TransferFormModel, setModel: SetModel, setError: SetText) {
  return async (code: string, name: string, page: number) => {
    try {
      const result = await queryReferences(tenantId, model, code, name, page);
      setModel((current) => {
        if (
          current.employeeId !== model.employeeId ||
          current.effectiveDate !== model.effectiveDate ||
          current.transferTypeCode !== model.transferTypeCode
        )
          return current;
        return code === 'departmentId'
          ? { ...current, departments: result.items }
          : { ...current, references: { ...current.references, [code]: result.items } };
      });
    } catch (cause) {
      setError(requestError(cause));
    }
  };
}
