import type { TransferFormAdapter } from './transfer-adapter.js';
import { useEffect, useRef, useState } from 'react';
import { missingTransferRequiredFields } from '@italent/domain';
import {
  EMPLOYMENT_API,
  TRANSFER_API,
  loadReferences,
  managerReferencePath,
  previewInput,
  queryReferences,
  requestError,
  saveTransfer,
  submitSavedTransfer,
  transferRequest,
  TransferApiError,
} from '../../transfer/api.js';
import { text } from '../../transfer/messages.js';
import { emptyLinkage } from '../../transfer/linkage-api.js';
import { useContractChoices } from '../../transfer/useLinkage.js';
import type {
  Choice,
  EmployeeChoice,
  FieldValue,
  LinkageDraft,
  TransferAction,
  TransferBusiness,
  TransferCatalog,
  TransferFormModel,
  TransferPreview,
} from '../../transfer/types.js';

const initial: TransferFormModel = {
  employees: [],
  departments: [],
  catalog: { types: [], reasons: [] },
  employeeId: '',
  effectiveDate: '',
  transferTypeCode: '',
  reasonCode: '',
  withEstablishment: false,
  fields: {},
  customFields: {},
  preview: null,
};
export function useTransferForm(
  tenantId: string,
  initiator: 'hr' | 'employee' | 'manager' = 'hr',
  adapter?: TransferFormAdapter,
) {
  const [model, setModel] = useState<TransferFormModel>({
    ...(adapter?.initialModel ?? initial),
    initiator,
    ...(initiator === 'hr' ? { linkage: emptyLinkage } : {}),
  });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const commands = useTransferCommand(tenantId, model, loadingPreview, setModel, setError, setNotice, adapter);
  useCatalog(tenantId, model.effectiveDate, setModel, setError, initiator, !adapter);
  useEmployees(tenantId, model.catalog.today, search, page, setModel, setError, initiator, !adapter);
  usePreview(tenantId, model, commands.saved, reload, setModel, setLoadingPreview, setError, setNotice, adapter);
  // R1-T10 的联动仅接入 HR；经理自助本轮仍不提供跨对象联动。
  useContractChoices(tenantId, initiator === 'hr' ? model.employeeId : '', initiator, setModel);
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
            ...(field === 'employeeId' ? { withEstablishment: false } : {}),
            // 换人后清空原员工的联动草稿与合同候选。
            ...(field === 'employeeId' && current.linkage ? { linkage: emptyLinkage, contracts: [] } : {}),
          },
    );
  };
  const field = editField(setModel);
  const refresh = () => {
    setError('');
    setModel((current) => ({ ...current, fields: {}, customFields: {}, preview: null }));
    setReload((value) => value + 1);
  };
  const reset = () => {
    commands.setSaved(null);
    setModel((current) => ({ ...current, withEstablishment: false }));
    commands.resetConflict();
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
    linkage: (patch: Partial<LinkageDraft>) =>
      setModel((current) => (current.linkage ? { ...current, linkage: { ...current.linkage, ...patch } } : current)),
    withEstablishment: (value: boolean) => setModel((current) => ({ ...current, withEstablishment: value })),
    refresh,
    reset,
    setPage: (next: number) => {
      setPage(next);
      selection('employeeId', '');
    },
    referenceQuery: referenceQuery(tenantId, model, setModel, setError, adapter),
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
  adapter?: TransferFormAdapter,
) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<TransferBusiness | null>(null);
  const [unknownCommand, setUnknownCommand] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const requestInProgress = useRef(false);
  const submit = async (action: TransferAction) => {
    if (
      needsReload ||
      !model.preview ||
      model.preview.requiredFieldsUnavailable ||
      requestInProgress.current ||
      unknownCommand ||
      loadingPreview
    )
      return;
    if (missingTransferRequiredFields(model.preview.form, { ...model.preview.fields, ...model.fields }).length > 0)
      return;
    requestInProgress.current = true;
    setBusy(true);
    setError('');
    const commandId = crypto.randomUUID();
    try {
      const result = saved
        ? await submitSavedTransfer(tenantId, saved, commandId)
        : await (adapter?.save ?? saveTransfer)(tenantId, model, action, commandId);
      if (!result.id || !Number.isInteger(result.revision) || !result.status) throw new Error(text.unknown);
      setSaved(result);
      setNotice(savedNotice(result, action));
    } catch (cause) {
      if (!(cause instanceof TransferApiError) || cause.status >= 500) {
        setUnknownCommand(commandId);
        setError(text.unknown);
      } else setError(requestError(cause));
      if (cause instanceof TransferApiError && cause.code === 'REVISION_CONFLICT') {
        if (saved) setNeedsReload(true);
        else setModel((current) => ({ ...current, preview: null }));
      }
    } finally {
      setBusy(false);
      requestInProgress.current = false;
    }
  };
  const reloadSaved = async () => {
    if (!saved || requestInProgress.current) return;
    requestInProgress.current = true;
    setBusy(true);
    setError('');
    try {
      const { latest, refreshed } = await reloadSavedModel(tenantId, model, saved);
      setModel(refreshed);
      setSaved(latest);
      setNeedsReload(false);
      setNotice(text.draftReloaded);
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
      requestInProgress.current = false;
    }
  };
  return {
    busy,
    saved,
    unknownCommand,
    submit,
    setSaved,
    needsReload,
    reloadSaved,
    resetConflict: () => setNeedsReload(false),
  };
}

type SetModel = React.Dispatch<React.SetStateAction<TransferFormModel>>;
type SetText = React.Dispatch<React.SetStateAction<string>>;
function useCatalog(
  tenantId: string,
  date: string,
  setModel: SetModel,
  setError: SetText,
  initiator: string,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const query = `?initiator=${initiator}${date ? `&effectiveDate=${encodeURIComponent(date)}` : ''}`;
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
  }, [tenantId, date, setModel, setError, initiator, enabled]);
}
function useEmployees(
  tenantId: string,
  today: string | undefined,
  search: string,
  page: number,
  setModel: SetModel,
  setError: SetText,
  initiator: string,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || !today) return;
    const controller = new AbortController();
    const query = new URLSearchParams({
      asOf: today,
      status: 'employed',
      name: search,
      page: String(page),
      pageSize: '50',
    });
    void transferRequest<{ items: EmployeeChoice[] }>(
      tenantId,
      initiator === 'employee'
        ? `${TRANSFER_API}/self`
        : initiator === 'manager'
          ? `${TRANSFER_API}/manager/employees?search=${encodeURIComponent(search)}&page=${page}&pageSize=50`
          : `${EMPLOYMENT_API}/employees?${query}`,
      {
        signal: controller.signal,
      },
    )
      .then((result) => {
        if (!controller.signal.aborted)
          setModel((current) => ({
            ...current,
            employees: result.items,
            ...(initiator === 'employee' ? { employeeId: result.items[0]?.id ?? '' } : {}),
          }));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(requestError(cause));
      });
    return () => controller.abort();
  }, [tenantId, today, search, page, setModel, setError, initiator, enabled]);
}
function usePreview(
  tenantId: string,
  model: TransferFormModel,
  saved: TransferBusiness | null,
  reload: number,
  setModel: SetModel,
  setBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setError: SetText,
  setNotice: SetText,
  adapter?: TransferFormAdapter,
) {
  const input = JSON.stringify(previewInput(model));
  useEffect(() => {
    if (saved || !model.employeeId || !model.effectiveDate || !model.transferTypeCode) {
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      void (adapter?.loadPreview ?? loadPreview)(tenantId, model, controller.signal)
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
  }, [tenantId, model.employeeId, input, saved, reload, setModel, setBusy, setError, setNotice, adapter]);
}
async function loadPreview(tenantId: string, model: TransferFormModel, signal: AbortSignal) {
  const preview = await transferRequest<TransferPreview>(
    tenantId,
    `${TRANSFER_API}/employees/${model.employeeId}/preview`,
    { method: 'POST', body: JSON.stringify(previewInput(model)), signal },
  );
  const query = new URLSearchParams({ formId: preview.form.id, effectiveDate: model.effectiveDate, pageSize: '100' });
  const [departments, references] = await Promise.all([
    preview.form.fieldModes['preset:departmentId'] &&
    !['hidden', 'absent'].includes(preview.form.fieldModes['preset:departmentId'])
      ? transferRequest<{ items: Choice[] }>(
          tenantId,
          model.initiator === 'manager'
            ? managerReferencePath(model, preview, 'departmentId')
            : `${TRANSFER_API}/departments?${query}`,
          { signal },
        )
      : Promise.resolve({ items: [] }),
    loadReferences(tenantId, preview, model, signal),
  ]);
  return { preview, departments: departments.items, ...references };
}

function referenceQuery(
  tenantId: string,
  model: TransferFormModel,
  setModel: SetModel,
  setError: SetText,
  adapter?: TransferFormAdapter,
) {
  return async (code: string, name: string, page: number) => {
    try {
      const result = await (adapter?.queryReferences ?? queryReferences)(tenantId, model, code, name, page);
      setModel((current) => {
        if (
          current.employeeId !== model.employeeId ||
          current.effectiveDate !== model.effectiveDate ||
          current.transferTypeCode !== model.transferTypeCode ||
          current.fields.departmentId !== model.fields.departmentId
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

async function reloadSavedModel(tenantId: string, model: TransferFormModel, saved: TransferBusiness) {
  const latest = await transferRequest<TransferBusiness>(tenantId, `${EMPLOYMENT_API}/businesses/${saved.id}`);
  if (latest.id !== saved.id || !Number.isInteger(latest.revision) || !latest.fields) throw new Error(text.failed);
  const modelWithDate = {
    ...model,
    effectiveDate: latest.effectiveDate ?? model.effectiveDate,
    fields: {},
    customFields: {},
  };
  const loaded = await loadPreview(tenantId, modelWithDate, new AbortController().signal);
  return {
    latest,
    refreshed: {
      ...modelWithDate,
      ...loaded,
      preview: { ...loaded.preview, fields: latest.fields, customFields: latest.customFields ?? {} },
    },
  };
}

function savedNotice(result: TransferBusiness, action: TransferAction) {
  if (result.status === 'draft') return text.draftSaved;
  if (action === 'direct') return result.status === 'effective' ? text.effective : text.scheduled;
  return text.submitted;
}

function editField(setModel: SetModel) {
  return (source: 'preset' | 'custom', code: string, value: FieldValue) => {
    const key = source === 'preset' ? 'fields' : 'customFields';
    setModel((current) => {
      const values = { ...current[key], [code]: value };
      if (source === 'preset' && code === 'postId') delete values.sequenceId;
      if (current.initiator === 'employee' && source === 'preset' && code === 'departmentId')
        delete values.directManagerId;
      return { ...current, [key]: values };
    });
  };
}
