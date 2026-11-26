import { useEffect, useReducer } from 'react';
import { ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { queryCommandResult } from '../foundation/forms/command-result.js';
import { messages } from '../foundation/forms/messages.js';
import { sharedRecovery } from '../foundation/forms/recovery.js';
import { createFormStore, isLocked, type Submission } from '../foundation/forms/store.js';
import { slotKey } from '../foundation/forms/slot.js';
import { changedFields, type Values } from '../foundation/forms/values.js';
import { createRefusalMarks, useRefusalMarks } from '../approval/refusal-marks.js';
import { collection, detailPath, type Detail } from './model.js';

// DEC-955 只禁调动 / 审批写入：组织调整在浏览器不支持 Web Locks 时退回无锁登记，照常保存。
const store = createFormStore({ recovery: sharedRecovery('org-adjustment', { requireLocks: false }) });
/** F-566：与 store 同为模块级，详情、编辑弹窗、新建入口的各挂载实例共用（关闭重开详情也认得处理中的命令）。 */
const marks = createRefusalMarks();
/**
 * F-570：提交前同步就锁到别页未确认命令时，内核按恢复态返回“结果未知 + race”，error 为空（store.ts submitTo）。
 * 原因按槽记下占槽命令 ID，只在该槽仍是结果未知、且占着的正是这条命令时显示（同 F-558 / F-562）：
 * 回查中、回查 404（内核复制条目、命令不变）照旧显示；查询确认结果、别页落定（条目删掉）或占槽命令换掉即不再显示。
 * 槽键不含租户：靠命令 ID（客户端生成的 UUID）核对，换租户 / 身份后同名槽上的命令不同，不会串显。
 * 只处理结果未知：登记冲突、同步发现占槽两条 rejected + race 的条目本身带“其他标签页”error，照旧由状态区显示。
 */
const races = new Map<string, { commandId: string; reason: string }>();
const raceListeners = new Set<() => void>();

/** 与 F-566 的拒绝标记相同：内核此时不发布新条目，记下原因后让各挂载实例重绘（只订阅本模块，AC-FE-F142）。 */
function useMarks() {
  useRefusalMarks(marks);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    raceListeners.add(rerender);
    return () => void raceListeners.delete(rerender);
  }, []);
}

/** 槽上记下的竞争原因：仍是结果未知、占槽的仍是那条命令才算数（F-570 第 2 轮 P2-2）。 */
function raceOf(slot: string, state: Submission | undefined) {
  const race = races.get(slot);
  return state?.status === 'unknown' && race && state.command?.id === race.commandId ? race.reason : undefined;
}

/**
 * notice：槽已交给别页命令时本次未发出的原因（等锁超时 DEC-954；F-570 竞争），详情状态区另行显示；
 * race：F-570 锁到别页命令的原因，弹窗按当前占槽命令显示（不留在弹窗本地错误里）。
 */
function notices(slot: string, state: Submission | undefined) {
  const race = raceOf(slot, state);
  return { notice: marks.notice(state) ?? race, race };
}

async function settle(
  slot: string,
  command: { peek(): Submission | undefined },
  submit: Parameters<typeof marks.settle>[1],
) {
  races.delete(slot);
  const result = await marks.settle(command, submit);
  if (result.status !== 'unknown' || !result.race) return result;
  races.set(slot, { commandId: result.race.commandId, reason: result.race.reason });
  raceListeners.forEach((listener) => listener());
  // 本次未发出、已由提示区按占槽命令显示原因（详情 notice、弹窗 race）：同 refusal-marks 抛 undefined，
  // 弹窗不留本地错误，别页落定、条目删掉后随之解锁并清掉提示（第 2 轮 P2-1）。
  throw undefined;
}
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
  useMarks();
  // 详情读回更新的版本后，过期竞争条目不再回填编辑草稿（F-566 第 3 轮 P2-4）。command 每次渲染都是新对象，
  // 过期标记在 settle 里落定、条目对象不变时也会再核一次（核对只读存储，不满足条件不动）。
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
    const result = await settle(slotKey(collection, id), command, submit);
    if (result.status !== 'done' || !result.businessId) throw result.error ?? new Error(messages.unknown);
    updated(result.businessId);
    command.clear();
  }

  return {
    form: { ...command, state: marks.view(command.state), reload, queryResult },
    ...notices(slotKey(collection, id), command.state),
    access: { ...access, field: recoveryField(access, row, command.state?.latest?.values) },
    baseline,
    send,
  };
}
