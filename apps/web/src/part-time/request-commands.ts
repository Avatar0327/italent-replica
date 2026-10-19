import { useRef, useState } from 'react';
import { message } from 'antd';
import { ApiError } from '../foundation/client.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { usePermissions } from '../foundation/Permissions.js';
import { createFormStore, lockedContext, type Values } from '../foundation/forms/store.js';
import { forAction } from '../foundation/forms/action.js';
import { validObject } from '../foundation/forms/ConflictCommands.js';
import { slotKey } from '../foundation/forms/slot.js';
import { useCommandForm, type CommandForm } from '../foundation/forms/useCommandForm.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { confirmNotice } from '../approval/before-approve.js';
import { shorteningNotice } from './request-confirmation.js';
import { apiRoot, object, type Row } from './model.js';
import {
  acceptRequest,
  actionsFor,
  bodyFor,
  canCreate,
  requestError,
  requests,
  requestValues,
  type RequestAction,
  type RequestKind,
} from './request-model.js';
import { r } from './request-messages.js';

// 与审批中心一致，模块存储跨页面入口存活；键仍由内核按租户/身份隔离。
const store = createFormStore();
export interface RequestSelection {
  kind: RequestKind;
  action: 'create' | RequestAction;
  row?: Row;
  target?: Row;
}
type Context = Values & RequestSelection & { sourceId?: string; createdId?: string };
export function useRequestAccess() {
  const permissions = usePermissions(object);
  return { permissions, permission: permissions.snapshot.objects[object] };
}
export function useRequestCommand(selection: RequestSelection, refresh: () => Promise<unknown>) {
  const api = useApiClient();
  const session = useSession();
  const resource = slotKey(requests, selection.action === 'create' ? undefined : selection.row!.id);
  const raw: CommandForm = useCommandForm(resource, store);
  const pending = lockedContext<Context>(raw.state);
  // 新建三个入口共用集合槽；锁定时恢复原类型与原目标，不能换入口建第二单。
  const chosen = selection.action === 'create' && pending ? pending : selection;
  const command = forAction(raw, { action: chosen.action });
  const { kind, action, target } = chosen;
  const [latest, setLatest] = useState<Row>();
  const row = latest ?? chosen.row;
  const baseline =
    action === 'create'
      ? target
        ? { ...requestValues(target), originalEndDate: target.endDate, endDate: null, requestRemark: null }
        : { ...requestValues({ id: '' }), employeeId: null }
      : requestValues(row!);
  const full = command.state?.latest?.values ?? baseline;
  const { permission, permissions } = useRequestAccess();
  const allowed =
    action === 'create'
      ? canCreate(kind, permission)
      : actionsFor(full, permission).includes(action) &&
        validObject({ id: row?.id, revision: typeof full.revision === 'number' ? full.revision : undefined });
  const accessNow = useRef({ allowed, permissions });
  accessNow.current = { allowed, permissions };
  const scoped = (path: string) => JSON.stringify([session.tenantId, session.identityKey, path]);
  async function readRequest(id: string) {
    const result = await api.request<Row>(slotKey(requests, id));
    if (result.id !== id || !Number.isSafeInteger(result.revision)) throw new Error(kernel.invalidReceipt);
    return result;
  }
  const reload = async () => {
    await command.reread(async (id) => {
      const ctx = command.peek()?.context as Context | undefined;
      if (action !== 'create' || ctx?.createdId) {
        const next = await readRequest(ctx?.createdId ?? row!.id);
        if (action !== 'create') setLatest(next);
        return { id: id!, revision: action === 'create' ? 0 : Number(next.revision), values: requestValues(next) };
      }
      if (!ctx?.sourceId) throw new Error(r.unknownNew);
      const source = await api.request<Row>(
        `${apiRoot}/${kind === 'add' ? 'employees' : 'part-times'}/${ctx.sourceId}`,
      );
      if (source.id !== ctx.sourceId) throw new Error(kernel.invalidReceipt);
      // 新建还没有申请：核对原人员/兼职记录。已填输入由内核保留；目标原结束日取当前读值。
      return {
        id: id!,
        revision: 0,
        values:
          kind === 'add'
            ? baseline
            : {
                ...requestValues(source),
                originalEndDate: source.endDate,
                endDate: null,
                requestRemark: null,
              },
      };
    });
  };
  async function run(values: Values, editable: string[], submit: boolean) {
    if (!allowed || (submit && !permissions.can('Employment.Submit')))
      throw new ApiError(403, 'FORBIDDEN', 'forbidden', r.denied);
    const current = command.state?.latest?.values ?? full;
    if (submit || action === 'submit') await confirmNotice(shorteningNotice({ ...current, ...values, kind }));
    if (
      !accessNow.current.allowed ||
      editable.some((key) => key !== 'employeeId' && !accessNow.current.permissions.field(key).editable)
    )
      throw new ApiError(403, 'FORBIDDEN', 'forbidden', r.denied);
    const sourceId = action === 'create' ? String(target?.id ?? values.employeeId ?? '') : row!.id;
    const context: Context = { ...chosen, sourceId };
    let createdSlot: string | undefined;
    const key = store.holder([scoped(resource)]) ?? scoped(resource);
    const result = await command.submit({
      values,
      baseline,
      editableFields: editable,
      revision: action === 'create' ? 0 : Number(row!.revision),
      // 建单以真实原人员/兼职记录为恢复对象；回执验证仍检查新申请 id/revision，写后再钉新申请槽。
      businessId: sourceId,
      patchOnly: action === 'edit',
      context,
      send: async (sent) => {
        const activeContext = command.peek()?.context as Context;
        activeContext.sourceId = sourceId;
        let receipt: Row;
        try {
          const path =
            action === 'create'
              ? requests
              : slotKey(requests, row!.id) + (['edit', 'delete'].includes(action) ? '' : `/${action}`);
          const raw = await api.request<unknown>(path, {
            method: action === 'edit' ? 'PATCH' : action === 'delete' ? 'DELETE' : 'POST',
            command: {
              ...sent,
              body: bodyFor(
                kind,
                action,
                { ...sent.body, ...(action === 'create' && kind !== 'add' ? { recordId: target!.id } : {}) },
                submit,
              ),
            },
          });
          receipt = acceptRequest(raw, action === 'create' ? undefined : row!.id, sent.revision!);
        } catch (error) {
          throw requestError(error);
        }
        if (action === 'create') {
          const active = command.peek()?.context as Context;
          active.createdId = receipt.id;
          createdSlot = scoped(slotKey(requests, receipt.id));
          store.pin([createdSlot], key);
        }
        try {
          const next = await readRequest(receipt.id);
          if (Number(next.revision) < Number(receipt.revision)) throw new Error(kernel.invalidReceipt);
          await refresh();
        } catch {
          throw new Error(kernel.unknown);
        }
        for (const warning of (receipt.warnings as { reason: string }[] | undefined) ?? [])
          void message.warning(
            warning.reason === 'PART_TIME_NOT_EXTENDED'
              ? r.shortened
              : warning.reason === 'PART_TIME_SPANS_PENDING_EXIT'
                ? r.pendingExit
                : r.warning(warning.reason),
          );
        context.createdId = receipt.id;
        return { id: sourceId };
      },
    });
    if (result.status !== 'done') {
      if (result.status === 'rejected' && result.error instanceof ApiError && result.error.status === 403 && row) {
        // 拒绝已确定：重读后释放被拒命令，下一次从新 revision 出发；读取失败仍是拒绝，不伪称 unknown。
        try {
          setLatest(await readRequest(row.id));
          command.clear();
        } catch {
          /* 保留拒绝提示，允许显式重读 */
        }
      }
      throw result.error ?? new Error(kernel.unknown);
    }
    command.clear();
    if (createdSlot) store.unpin([createdSlot], key);
    void message.success(r.saved);
    return context.createdId;
  }
  return {
    kind,
    action,
    row,
    target,
    baseline,
    full,
    allowed,
    permissions,
    run,
    command: { ...command, reload },
    async rereadRejected() {
      if (row) {
        setLatest(await readRequest(row.id));
        command.clear();
      }
    },
  };
}
