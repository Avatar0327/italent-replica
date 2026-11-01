import { useCallback, useRef } from 'react';
import { slotKey } from '../foundation/forms/slot.js';
import { isLocked, type Latest } from '../foundation/forms/store.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { projectFields, type Values } from '../foundation/forms/values.js';
import { useApiClient } from '../foundation/Session.js';
import { type ApplicationDraft, useInternDraft } from '../intern/commands.js';
import { m } from './messages.js';
import { retirements, retireSlot } from './model.js';

export type RetireDraft = ApplicationDraft;
/**
 * 草稿的核对字段：退休详情（GET /retirements/:id）里当前可见的业务字段。第二步只发空体，不写这些字段，
 * 但冲突重读要拿它们和打开时比较、回填只读表单（第 3 轮 P2-R2-1）。被字段权裁剪的缺键按 null。
 */
export const draftFields = ['lastWorkDate', 'handoverEmployeeId'] as const;
/** 仍可作为草稿接续的单据状态（entriesFor：草稿 / 驳回可提交）；状态被裁剪时无从判断，按仍可接续处理。 */
const resumable = (status: unknown) => status === undefined || status === 'draft' || status === 'rejected';
/** 已写后回读确认的单据动作：申请第二步与详情提交都是 submit。 */
export type DraftAction = 'submit' | 'withdraw' | 'cancel';
/**
 * 动作确认后本单还能否作为草稿接续：按写后回读的状态；状态被裁剪时按动作的终点（transitions.ts：
 * withdraw → draft 可接续，submit → in_review、cancel → voided 不可接续）。
 */
const reopened = (action: DraftAction, status: unknown) =>
  status === undefined ? action === 'withdraw' : resumable(status);

/**
 * 退休申请草稿的唯一入口（DEC-431①）：接续、重读、冲突核对、清理都在这里，RetireForm 与 RetirementDetail 只调用它。
 * 草稿存页面层（intern InternCommands，按会话 + 员工）；恢复槽仍是员工（slotKey 稳定），读回的 id 用员工 id。
 */
export function useRetireDraft(employeeId: string) {
  const api = useApiClient();
  const cache = useInternDraft(employeeId);
  const slot = useCommandForm(slotKey(retireSlot, employeeId));
  // 打开读与重读在异步流程里取存储的当前值；回调保持稳定，避免打开读随缓存刷新反复触发
  const live = useRef({ cache, slot });
  live.current = { cache, slot };
  const detail = useCallback(
    async (id: string) => {
      const latest = await api.request<Values>(slotKey(retirements, id));
      if (latest.id !== id || latest.employeeId !== employeeId || !Number.isSafeInteger(latest.revision))
        throw new Error(m.invalidReceipt);
      return latest;
    },
    [api, employeeId],
  );
  const snapshot = useCallback(
    (latest: Values): Latest => ({
      id: employeeId,
      revision: Number(latest.revision),
      values: projectFields(latest, draftFields),
    }),
    [employeeId],
  );
  /** 冲突重读与“回查原单”：读真实草稿的 revision 与核对字段。 */
  const read = useCallback(async () => {
    const draft = live.current.cache.draft;
    if (!draft) throw new Error(m.invalidReceipt);
    return snapshot(await detail(draft.id));
  }, [detail, snapshot]);
  /**
   * 打开申请：缓存里有草稿时先读它当前的状态。仍是草稿 / 驳回才按真实 revision 与字段接续；已提交、审批中、已办结、
   * 已撤销的清掉缓存，走新建（fallback 读员工）。员工恢复槽只拦处理中 / 结果未知（不读不清，保持原锁）；
   * 冲突不钉槽，重开即按新 revision 重读（Claude 交叉审 P3-1）。
   */
  const resume = useCallback(
    async (fallback: () => Promise<Latest>): Promise<Latest> => {
      const { cache, slot } = live.current;
      const draft = cache.draft;
      if (!draft) return fallback();
      // 处理中 / 结果未知：原命令仍钉在槽上，沿用缓存的 revision 与字段，由内核回查原单
      if (isLocked(slot.peek())) return { id: employeeId, revision: draft.revision, values: draft.values };
      // 读不到（含 404 / 无权）不猜草稿去向：打开读报错并可重试，不清缓存、不新建
      const latest = await detail(draft.id);
      if (!resumable(latest.status)) {
        live.current.cache.put();
        return fallback();
      }
      const opening = snapshot(latest);
      live.current.cache.put({ id: draft.id, revision: opening.revision, values: opening.values });
      return opening;
    },
    [detail, employeeId, snapshot],
  );
  return {
    /** 已确认创建、尚未确认提交的草稿。 */
    draft: cache.draft,
    read,
    resume,
    /** 新建草稿已确认：记下草稿 id、revision 与提交时的核对字段。 */
    created: (draft: RetireDraft) => cache.put({ ...draft, values: projectFields(draft.values, draftFields) }),
    /**
     * 同一业务 id 的提交 / 撤回 / 撤销写后回读已确认（第 4 轮 P2-R3-1）：按动作与回读状态决定本单引用的去留。
     * 回到草稿 / 驳回（撤回）：保留或恢复本单引用，revision 取回读值，字段与 revision 在下次打开时由 resume 读退休详情刷新；
     * 进入审批中 / 已作废等不可接续状态：清掉本单引用。缓存里是别的业务 id，或员工恢复槽处理中 / 结果未知时一律不动。
     */
    settled: (id: string, action: DraftAction, readback: Values = {}) => {
      const { cache, slot } = live.current;
      const held = cache.draft;
      if ((held && held.id !== id) || isLocked(slot.peek())) return;
      if (!reopened(action, readback.status)) return held && cache.put();
      const revision = Number(readback.revision ?? held?.revision);
      if (!Number.isSafeInteger(revision)) return;
      cache.put({ id, revision, values: held?.values ?? projectFields({}, draftFields) });
    },
  };
}
export type RetireDrafts = ReturnType<typeof useRetireDraft>;
