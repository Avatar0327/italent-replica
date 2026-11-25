import { ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import { useReducer, useRef } from 'react';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { queryCommandResult } from '../foundation/forms/command-result.js';
import { messages } from '../foundation/forms/messages.js';
import { sharedRecovery } from '../foundation/forms/recovery.js';
import { createFormStore, isLocked, type Outcome, type Submission } from '../foundation/forms/store.js';
import { slotKey } from '../foundation/forms/slot.js';
import { changedFields, type Values } from '../foundation/forms/values.js';
import { collection, detailPath, type Detail } from './model.js';

// DEC-955 只禁调动 / 审批写入：组织调整在浏览器不支持 Web Locks 时退回无锁登记，照常保存。
const store = createFormStore({ recovery: sharedRecovery('org-adjustment', { requireLocks: false }) });
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

/**
 * F-566（同 F-562 第 2 轮 P2-1）：本次提交处理中内核在返回前就发布 rejected 条目；登记冲突后占槽命令已在本页处理
 * 拒绝前落定时，它的 error 是旧的“其他标签页”文案，详情状态区与编辑弹窗的 CommandStatus 都不能读。
 * 处理完之后的 rejected（未发出的 refused、已发出被拒、主动查询结果确认失败）照常显示。
 */
function statusState(state: Submission | undefined, settling: boolean) {
  return settling && state?.status === 'rejected' ? undefined : state;
}
/**
 * 本次未发出的拒绝只取内核 refused 的文案（DEC-954、存储不可用），条目留给 CommandStatus 显示；
 * 竞争（race）仍按原样显示占槽命令。两者都不带时 error 是旧的“其他标签页”文案：清掉条目，
 * 抛空值让弹窗保持打开、保留输入且不提示（FormOverlay 只对有值的错误显示提示）。
 */
function refuseUnsent(result: Outcome, issued: boolean, clear: () => void) {
  if (result.status !== 'rejected' || issued || result.race) return;
  if (result.refused) throw new Error(result.refused);
  clear();
  throw undefined;
}
/**
 * 提交处理中的标记：调用内核前同步置上，内核返回后放下并按当前条目重新渲染（refused 时内核不再发布新条目，
 * 不重渲染就一直拿着处理中被隐去的状态），再按 refuseUnsent 处理未发出的拒绝。
 */
function useSettling() {
  const settling = useRef(false);
  const [, settled] = useReducer((count: number) => count + 1, 0);
  const settle = async (pending: Promise<Outcome>, issued: () => boolean, clear: () => void) => {
    const result = await pending.finally(() => {
      settling.current = false;
      settled();
    });
    refuseUnsent(result, issued(), clear);
    return result;
  };
  return { settling, settle };
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
  const { settling, settle } = useSettling();
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
    let issued = false;
    settling.current = true;
    const submitted = command.submit({
      businessId: id,
      revision: row?.revision ?? 0,
      baseline,
      values,
      editableFields,
      patchOnly: action === 'edit',
      context: { action, effectiveDate: values.effectiveDate ?? latest.effectiveDate },
      send: async (sent) => {
        issued = true;
        const receipt = await api.request<unknown>(url, {
          method: action === 'edit' ? 'PATCH' : 'POST',
          command: sent,
        });
        return acceptReceipt(receipt, id, sent.revision);
      },
    });
    const result = await settle(submitted, () => issued, command.clear);
    if (result.status !== 'done' || !result.businessId) throw result.error ?? new Error(messages.unknown);
    updated(result.businessId);
    command.clear();
  }

  return {
    form: { ...command, state: statusState(command.state, settling.current), reload, queryResult },
    access: { ...access, field: recoveryField(access, row, command.state?.latest?.values) },
    baseline,
    send,
  };
}
