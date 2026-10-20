import { Modal } from 'antd';
import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import type { Command } from '../foundation/client.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { slotKey } from '../foundation/forms/slot.js';
import { FormCommands, type CommandForm } from '../foundation/forms/useCommandForm.js';
import type { Latest } from '../foundation/forms/store.js';
import { sameValue, type Values } from '../foundation/forms/values.js';
import { useApiClient } from '../foundation/Session.js';
import { useDirectApi } from '../part-time/direct-api.js';
import { m } from './messages.js';
import { apiRoot, confirmationOf, type Confirmation } from './model.js';

export interface Draft {
  id: string;
  revision: number;
}
interface Drafts {
  drafts: Readonly<Record<string, Draft>>;
  setDraft(employeeId: string, draft?: Draft): void;
}
const DraftContext = createContext<Drafts | undefined>(undefined);
/**
 * 页面根部：未确认命令的存储（F-123 内核，DEC-473）与本会话里建好、尚未提交的申请草稿（按员工 id）。
 * 读接口不列草稿，草稿只在本页可见（PR“未验证”）。
 */
export function InternCommands({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const setDraft = (employeeId: string, draft?: Draft) =>
    setDrafts(({ [employeeId]: _old, ...rest }) => (draft ? { ...rest, [employeeId]: draft } : rest));
  return (
    <FormCommands>
      <DraftContext.Provider value={{ drafts, setDraft }}>{children}</DraftContext.Provider>
    </FormCommands>
  );
}
export const useDrafts = () => useContext(DraftContext)!;

/** 对象最新版本：员工（三个入口的 If-Match）或申请单（提交 / 撤回 / 撤销）。重读回填的值以打开时的空基线为准。 */
export function useLatest(path: string, baseline: Values) {
  const api = useApiClient();
  return async () => {
    const latest = await api.request<{ id?: unknown; revision?: unknown }>(path);
    if (typeof latest.id !== 'string' || !Number.isSafeInteger(latest.revision)) throw new Error(m.invalidReceipt);
    return { id: latest.id, revision: Number(latest.revision), values: baseline };
  };
}
export const employeePath = (employeeId: string) => slotKey(`${apiRoot}/employees`, employeeId);

function ask(confirmation: Confirmation) {
  return new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: m.confirmTitle,
      content: confirmation.message,
      okText: m.confirm,
      cancelText: m.cancel,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

export interface Send {
  path: string;
  body(edited: Values): Values;
  /** 回执校验：用实际提交的 command.revision；不符抛错，内核按结果未知锁定。 */
  accept(raw: Values, sent: number): void;
}
/**
 * 一个提交点（resource + 对象 id + 动作）：409 冲突、结果未知、明确拒绝都交内核；服务端要求二次确认时
 * （CONFIRMATION_REQUIRED / 在途调动令牌）先弹确认，确认后带确认项在同一恢复槽、同一命令上下文里重提——
 * 被拒的命令已确定没有写入，重提是新命令（内容不同），基线与 revision 沿用原槽（store.submit prior）。
 */
export function useInternCommand(
  resource: string,
  target: { id: string; revision: number | undefined; baseline: Values; read: () => Promise<Latest> },
  action: string,
) {
  const post = useDirectApi();
  const snapshot = { id: target.id, revision: target.revision ?? -1, values: target.baseline };
  const cmd = useConflictCommand(resource, snapshot, target.read, { action });
  // 同一提交点只跑一个提交循环：连点或确认框打开期间再点不会把锁定中的原命令当作失败显示
  const running = useRef(false);
  return {
    ...cmd,
    /** 处理中 / 结果未知 / 冲突、对象标识无效，或本员工有别的入口的命令未确认（forAction blocked）：不能提交。 */
    disabled: cmd.form.locked || cmd.invalid || !!(cmd.form as CommandForm).blocked,
    async submit(
      values: Values,
      editableFields: readonly string[],
      send: Send,
      onConfirmation?: (confirmation: Confirmation) => void,
    ) {
      // 返回是否真正写入完成：并发的第二次点击直接返回 false，调用方不得据此提示成功
      if (running.current) return false;
      running.current = true;
      try {
        await submitConfirmed(
          cmd.run,
          target.id,
          send,
          values,
          editableFields,
          (raw) => post(send.path, 'POST', raw),
          onConfirmation,
        );
        return true;
      } finally {
        running.current = false;
      }
    },
  };
}
export type InternCommand = ReturnType<typeof useInternCommand>;

type Run = ReturnType<typeof useConflictCommand>['run'];
async function submitConfirmed(
  run: Run,
  id: string,
  send: Send,
  values: Values,
  editableFields: readonly string[],
  post: (command: Command<Values>) => Promise<Values>,
  onConfirmation?: (confirmation: Confirmation) => void,
) {
  let extra: Values = {};
  for (;;) {
    try {
      await run({
        values,
        editableFields,
        send: async ({ edited, command }: { edited: Values; command: Command<Values> }) => {
          const raw = await post({ ...command, body: { ...send.body(edited), ...extra } });
          send.accept(raw, command.revision!);
          return { id };
        },
      });
      return;
    } catch (error) {
      const confirmation = confirmationOf(error);
      // 同一确认项已带上仍被要求确认：不再循环，按拒绝显示
      const repeated = Object.entries(confirmation?.extra ?? {}).every(([key, value]) => sameValue(extra[key], value));
      if (!confirmation || repeated) throw error;
      onConfirmation?.(confirmation);
      if (!(await ask(confirmation))) throw error;
      extra = { ...extra, ...confirmation.extra };
    }
  }
}
