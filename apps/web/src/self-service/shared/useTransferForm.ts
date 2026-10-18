import { loadPreview, reloadSavedModel, savedNotice } from './transfer-loading.js';
import { useHrTransferCommand } from '../../transfer/useHrTransferCommand.js';
import { applicationCommand, type ApplicationCommandRunner } from './application-command.js';
import type { TransferFormAdapter } from './transfer-adapter.js';
import { useEffect, useRef, useState } from 'react';
import { missingTransferRequiredFields } from '@italent/domain';
import {
  EMPLOYMENT_API,
  TRANSFER_API,
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
import { applyPendingDraft, catalogType } from '../../transfer/draft-restore.js';
import { useDraftRestore } from '../../transfer/useDraftRestore.js';
import type {
  EmployeeChoice,
  FieldValue,
  LinkageDraft,
  TransferAction,
  TransferBusiness,
  TransferCatalog,
  TransferFormModel,
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
  runCommand?: ApplicationCommandRunner,
  hrScope?: string,
  /** F-153：他人调动申请（有暂存）选人后按人带出暂存；“调动”入口没有暂存，不带出。 */
  restoreDrafts = false,
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
  const legacy = useTransferCommand(
    tenantId,
    model,
    loadingPreview,
    setModel,
    setError,
    setNotice,
    adapter,
    runCommand,
  );
  const hr = useHrTransferCommand(tenantId, model, loadingPreview, setModel, hrScope);
  const commands = hrScope ? hr : legacy;
  useCatalog(tenantId, model.effectiveDate, setModel, setError, initiator, !adapter);
  useEmployees(tenantId, model.catalog.today, search, page, setModel, setError, initiator, !adapter);
  usePreview(tenantId, model, commands.saved, reload, setModel, setLoadingPreview, setError, setNotice, adapter);
  // R1-T10 的联动仅接入 HR；经理自助本轮仍不提供跨对象联动。
  useContractChoices(tenantId, initiator === 'hr' ? model.employeeId : '', initiator, setModel);
  const draft = useDraftRestore(tenantId, restoreDrafts ? hrScope : undefined, model.employeeId, setModel);
  const selection = selectField(setModel, setError);
  const field = editField(setModel);
  const reread = (update: (current: TransferFormModel) => TransferFormModel) => {
    setError('');
    setModel(update);
    setReload((value) => value + 1);
  };
  const reset = () => {
    legacy.setSaved(null);
    legacy.resetConflict();
    setNotice('');
    reread(blankForm);
  };
  return {
    model,
    error,
    notice,
    ...commands,
    processing: !!hrScope && hr.processing,
    ...draftCommandState(draft, hr, commands, hrScope),
    commandNotice: hrScope ? hr.commandNotice : '',
    loadingPreview,
    draft,
    page,
    selection,
    field,
    linkage: (patch: Partial<LinkageDraft>) =>
      setModel((current) => (current.linkage ? { ...current, linkage: { ...current.linkage, ...patch } } : current)),
    withEstablishment: (value: boolean) => setModel((current) => ({ ...current, withEstablishment: value })),
    refresh: () => reread(keptForm),
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

/**
 * 重新读取表单不丢草稿（#350 第 1 轮 P2-2）：尚未回填的带出草稿原样保留，否则把当前改动作为待回填草稿，
 * 等新预览到达后按当时可编辑的字段回填。
 */
function keptForm(model: TransferFormModel): TransferFormModel {
  const { employeeId, fields, customFields } = model;
  const kept =
    model.pendingDraft || !employeeId ? model : { ...model, pendingDraft: { employeeId, fields, customFields } };
  return { ...kept, fields: {}, customFields: {}, preview: null };
}
const blankForm = (model: TransferFormModel): TransferFormModel => ({
  ...model,
  withEstablishment: false,
  fields: {},
  customFields: {},
  preview: null,
});
/** 换人时放弃待确认的带出类型，回到默认类型；选定类型即视为已确认。 */
function selectedType(current: TransferFormModel, field: string, value: string) {
  if (field === 'transferTypeCode') return { transferTypeCode: value, typeConfirmation: false };
  if (field === 'employeeId' && current.typeConfirmation)
    return { transferTypeCode: current.catalog.types[0]?.code ?? '', typeConfirmation: false };
  return {};
}
function selectField(setModel: SetModel, setError: SetText) {
  return (field: 'employeeId' | 'effectiveDate' | 'transferTypeCode' | 'reasonCode', value: string) => {
    setError('');
    setModel((current) =>
      field === 'reasonCode'
        ? { ...current, reasonCode: value }
        : {
            ...current,
            [field]: value,
            ...selectedType(current, field, value),
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
}

function useTransferCommand(
  tenantId: string,
  model: TransferFormModel,
  loadingPreview: boolean,
  setModel: SetModel,
  setError: SetText,
  setNotice: SetText,
  adapter?: TransferFormAdapter,
  runCommand?: ApplicationCommandRunner,
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
      const result = await executeTransfer(tenantId, { model, action, commandId, saved, adapter, runCommand });
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

function executeTransfer(
  tenantId: string,
  input: {
    model: TransferFormModel;
    action: TransferAction;
    commandId: string;
    saved: TransferBusiness | null;
    adapter?: TransferFormAdapter;
    runCommand?: ApplicationCommandRunner;
  },
) {
  const { model, action, commandId, saved, adapter, runCommand } = input;
  const execute = () =>
    saved
      ? submitSavedTransfer(tenantId, saved, commandId)
      : (adapter?.save ?? saveTransfer)(tenantId, model, action, commandId);
  return runCommand ? runCommand(applicationCommand(model, action, commandId, saved), execute) : execute();
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
          ...catalogType(current, catalog),
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
          // F-153：带出的暂存字段等对应预览到达后，按当前字段权限回填（DEC-511）。
          setModel((current) => applyPendingDraft({ ...current, ...result }));
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

function draftCommandState(
  draft: ReturnType<typeof useDraftRestore>,
  hr: ReturnType<typeof useHrTransferCommand>,
  commands: ReturnType<typeof useHrTransferCommand> | ReturnType<typeof useTransferCommand>,
  scope?: string,
) {
  const locked = !!scope && (draft.command.locked || draft.status === 'loading');
  return {
    busy: commands.busy || locked,
    conflict: scope ? (draft.command.locked ? draft.command : hr.conflict) : undefined,
    commandError: scope ? draft.error || hr.commandError : '',
    submit: (action: TransferAction) => (locked ? Promise.resolve() : commands.submit(action)),
  };
}
