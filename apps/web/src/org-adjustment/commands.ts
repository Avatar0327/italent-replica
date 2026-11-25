import { useEffect } from 'react';
import { ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { queryCommandResult } from '../foundation/forms/command-result.js';
import { messages } from '../foundation/forms/messages.js';
import { sharedRecovery } from '../foundation/forms/recovery.js';
import { createFormStore, isLocked } from '../foundation/forms/store.js';
import { slotKey } from '../foundation/forms/slot.js';
import { changedFields, type Values } from '../foundation/forms/values.js';
import { createRefusalMarks, useRefusalMarks } from '../approval/refusal-marks.js';
import { collection, detailPath, type Detail } from './model.js';

// DEC-955 只禁调动 / 审批写入：组织调整在浏览器不支持 Web Locks 时退回无锁登记，照常保存。
const store = createFormStore({ recovery: sharedRecovery('org-adjustment', { requireLocks: false }) });
/** F-566：与 store 同为模块级，详情、编辑弹窗、新建入口的各挂载实例共用（关闭重开详情也认得处理中的命令）。 */
const marks = createRefusalMarks();
type Action = 'create' | 'edit' | 'submit' | 'void';
const required = ['subject', 'effectiveDate', 'adjustmentRange', 'approvalSubjectOrgId'] as const;

export function useAdjustmentAccess() {
  const permission = usePermissions(ORG_ADJUSTMENT_OBJECT_CODE);
  const operations = permission.snapshot.objects[ORG_ADJUSTMENT_OBJECT_CODE]?.dataOperations;
  return {
    field: permission.field,
    add:
      !!operations?.create &&
      permission.can('AddAdjustOrgApprovalBtn', 'list') &&
      required.every((field) => permission.field(field).editable),
    edit: !!operations?.update && permission.can('EditAdjustOrgDetailBtn'),
    void: !!operations?.update && permission.can('OrganizationApprovalDelete', 'list_row'),
  };
}

function formValues(row?: Detail): Values {
  return {
    ...row,
    ...(row?.adjustmentRange && {
      rangeDisplay: row.adjustmentRange,
      adjustmentRange: row.adjustmentRange.map(({ orgId }) => orgId),
    }),
  };
}

type AdjustmentAccess = ReturnType<typeof useAdjustmentAccess>;

function recoveryField(access: AdjustmentAccess, row?: Detail, latest?: Values): AdjustmentAccess['field'] {
  return (name) => {
    // 权限快照可能比服务端读回旧。恢复区只能使用原单与最近重读都披露的字段。
    if (row && (!Object.hasOwn(row, name) || (latest && !Object.hasOwn(latest, name))))
      return { visible: false, editable: false };
    return access.field(name);
  };
}

export function acceptReceipt(receipt: unknown, id: string | undefined, sent: number | undefined) {
  const result = receipt as Partial<Detail> | null;
  if (
    typeof result?.id !== 'string' ||
    !result.id ||
    (id !== undefined && result.id !== id) ||
    typeof sent !== 'number' ||
    typeof result.revision !== 'number' ||
    !Number.isSafeInteger(result.revision) ||
    result.revision <= sent
  )
    throw new Error(messages.invalidReceipt);
  return { id: result.id };
}

export function useAdjustmentCommand(row: Detail | undefined, updated: (id: string) => void, access: AdjustmentAccess) {
  const api = useApiClient();
  const id = row?.id;
  const command = useCommandForm(slotKey(collection, id), store);
  useRefusalMarks(marks);
  // 详情读回更新的版本后，过期竞争条目不再回填编辑草稿（F-566 第 3 轮 P2-4）。
  useEffect(() => marks.supersede(command, row?.revision), [command, row?.revision]);
  const baseline = formValues(row);
  const reload = id
    ? () =>
        command.reread(async () => {
          const latest = await api.request<Detail>(detailPath(id));
          return { id: latest.id, revision: latest.revision, values: formValues(latest) };
        })
    : undefined;

  async function queryResult() {
    const result = await command.recoverResult((sent, state) =>
      queryCommandResult(api, sent.id, async (result) => {
        const businessId = result.businessId;
        if (
          !businessId ||
          (state.businessId && businessId !== state.businessId) ||
          result.revision === null ||
          sent.revision === undefined ||
          result.revision <= sent.revision
        )
          throw new Error(messages.invalidReceipt);
        const saved = await api.request<Detail>(detailPath(businessId));
        if (saved.id !== businessId || !Number.isSafeInteger(saved.revision) || saved.revision < result.revision)
          throw new Error(messages.invalidReceipt);
        return businessId;
      }),
    );
    if (result?.status === 'done' && result.businessId) {
      updated(result.businessId);
      command.clear();
    }
  }

  async function send(action: Action, values: Values = {}, editableFields: readonly string[] = []) {
    marks.supersede(command, row?.revision);
    const state = command.peek();
    const latest = state?.latest?.values ?? baseline;
    if (action === 'edit' && row && !changedFields(values, latest, editableFields).length) {
      if (isLocked(state)) throw state?.error ?? new Error(messages.unknown);
      command.clear();
      updated(row.id);
      return;
    }
    const writing = action === 'create' ? collection : detailPath(id!);
    const url = action === 'submit' || action === 'void' ? `${writing}/${action}` : writing;
    const submit = (issue: () => void) =>
      command.submit({
        businessId: id,
        revision: row?.revision ?? 0,
        baseline,
        values,
        editableFields,
        patchOnly: action === 'edit',
        context: { action, effectiveDate: values.effectiveDate ?? latest.effectiveDate },
        send: async (sent) => {
          issue();
          const receipt = await api.request<unknown>(url, {
            method: action === 'edit' ? 'PATCH' : 'POST',
            command: sent,
          });
          return acceptReceipt(receipt, id, sent.revision);
        },
      });
    const result = await marks.settle(command, submit);
    if (result.status !== 'done' || !result.businessId) throw result.error ?? new Error(messages.unknown);
    updated(result.businessId);
    command.clear();
  }

  return {
    form: { ...command, state: marks.view(command.state), reload, queryResult },
    /** 等锁超时等未发出的拒绝、而槽已交给别页命令时的原因（DEC-954），详情状态区另行显示。 */
    notice: marks.notice(command.state),
    access: { ...access, field: recoveryField(access, row, command.state?.latest?.values) },
    baseline,
    send,
  };
}
