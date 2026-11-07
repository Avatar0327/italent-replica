import { App } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { useConflictCommand, type Sending } from '../foundation/forms/ConflictCommands.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { CommandForm } from '../foundation/forms/useCommandForm.js';
import type { Latest } from '../foundation/forms/store.js';
import { projectFields, sameValue, type Values } from '../foundation/forms/values.js';
import { ui } from '../foundation/messages.js';
import { useApiClient } from '../foundation/Session.js';
import { confirmationOf } from '../intern/model.js';
import { useDirectApi } from '../part-time/direct-api.js';
import { x } from './messages.js';
import { detailValues, exits } from './exit-model.js';

type Api = ReturnType<typeof useApiClient>;
/** 写后回读与 409 重读：核对标识，返回 revision 与原始对象。 */
async function readObject(api: Api, path: string, id: string) {
  const latest = await api.request<Values>(path);
  if (latest.id !== id || !Number.isSafeInteger(latest.revision)) throw new Error(x.invalidReceipt);
  return latest;
}

/** 离职单的打开基线与重读（GET /exits/:id）：表单值只取详情实际投影，保留被裁剪键的缺席。 */
export function useExitRead(id: string) {
  const api = useApiClient();
  return useCallback(async (): Promise<Latest> => {
    const latest = await readObject(api, slotKey(exits, id), id);
    return { id, revision: Number(latest.revision), values: detailValues(latest) };
  }, [api, id]);
}

/** 二次确认走 App 上下文（F-352③）：静态 Modal.confirm 拿不到主题 / 语言上下文，antd 会告警。 */
export function useAsk() {
  const { modal } = App.useApp();
  return useCallback(
    (title: string, content: string) =>
      new Promise<boolean>((resolve) =>
        modal.confirm({
          title,
          content,
          okText: x.confirm,
          cancelText: x.cancel,
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      ),
    [modal],
  );
}

/** 表单提交：字段校验错误留在表单项上，其余（本地校验 / 拒绝）显示在表单上方；写入完成后提示并关闭。 */
export function useFormSubmit(locked: boolean, run: () => Promise<boolean | undefined>, onClose: () => void) {
  const { message } = App.useApp();
  const [error, setError] = useState<unknown>();
  const submit = async () => {
    if (locked) return;
    setError(undefined);
    try {
      if (!(await run())) return;
      void message.success(x.success);
      onClose();
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'errorFields' in cause)) setError(cause);
    }
  };
  return { error, submit };
}

export interface ExitSend {
  path: string;
  method: 'POST' | 'PATCH';
  /**
   * values = 最新全量里可提交的字段 + 人工修改的字段；confirm = 服务端要求确认后追加的确认项；edited = 人工修改的字段。
   * 不给 body：提交的 values 就是完整请求体，确认项并入内核命令体，内核保存的就是实际报文，结果未知时可按原命令重发。
   */
  body?(values: Values, confirm: Values, edited: Values): Values;
  /** 回执校验（用实际提交的 revision）；返回写后回读的对象，不需要回读时返回 undefined。 */
  accept(raw: Values, sent: number | undefined): { path: string; id: string; revision: number } | undefined;
  /** false：服务端要求确认也不进确认循环（F-240 超上限时后端不给令牌，不得出现确认提交）。 */
  confirmable?: boolean;
  /** 不带 If-Match（批量：版本在请求体里逐条给）。 */
  noRevision?: boolean;
}
type Ask = ReturnType<typeof useAsk>;
/** 先跑 first；服务端要求确认时弹确认，确认后带确认项走 retry 重提（DEC-258：每次确认是新命令）。 */
async function confirming(
  ask: Ask,
  send: ExitSend,
  first: () => Promise<void>,
  retry: (confirm: Values) => Promise<void>,
) {
  let confirm: Values = {};
  let next = first;
  for (;;) {
    try {
      return await next();
    } catch (error) {
      const confirmation = send.confirmable === false ? undefined : confirmationOf(error);
      const repeated = Object.entries(confirmation?.extra ?? {}).every(([k, v]) => sameValue(confirm[k], v));
      if (!confirmation || repeated || !(await ask(x.confirmTitle, confirmation.message))) throw error;
      const current = (confirm = { ...confirm, ...confirmation.extra });
      next = () => retry(current);
    }
  }
}
/**
 * 一个提交点（resource + 对象 + 动作）：409 冲突、结果未知、明确拒绝都交 F-123 内核（DEC-473）；
 * 服务端要求确认（CONFIRMATION_REQUIRED / 在途调动令牌）时先弹确认，确认后带确认项在同一恢复槽、同一命令上下文里重提。
 */
export function useExitCommand(
  resource: string,
  target: { id?: string; revision: number | undefined; baseline: Values; read?: () => Promise<Latest> },
  action: string,
  refresh: () => Promise<unknown>,
  objects?: readonly { id: string; revision: number }[],
) {
  const post = useDirectApi();
  const api = useApiClient();
  const ask = useAsk();
  const snapshot = { id: target.id, revision: target.revision ?? -1, values: target.baseline, objects };
  const cmd = useConflictCommand(resource, snapshot, target.read, { action });
  const running = useRef(false);
  const settle = async (check: ReturnType<ExitSend['accept']>) => {
    try {
      if (check && Number((await readObject(api, check.path, check.id)).revision) < check.revision)
        throw new Error(x.invalidReceipt);
      await refresh();
    } catch {
      throw new Error(x.unconfirmed);
    }
  };
  /** 一次内核命令的发送：给了 body 按最新全量拼请求体，否则内核命令体就是请求体。 */
  const sender =
    (send: ExitSend, editableFields: readonly string[], confirm: Values) =>
    async ({ edited, command }: Sending) => {
      const body = send.body
        ? send.body({ ...projectFields(cmd.full, editableFields), ...edited }, confirm, edited)
        : command.body;
      const sent = send.noRevision ? undefined : command.revision;
      const raw = await post(send.path, send.method, { ...command, revision: sent, body });
      await settle(send.accept(raw, sent));
      return { id: target.id ?? resource };
    };
  /** 带 confirm 的一次新提交（新命令、新键）；不给 body 时确认项进命令体。 */
  const attempt = (values: Values, editableFields: readonly string[], send: ExitSend) => (confirm: Values) =>
    cmd.run({
      values: send.body ? values : { ...values, ...confirm },
      editableFields: send.body ? editableFields : [...editableFields, ...Object.keys(confirm)],
      send: sender(send, editableFields, confirm),
    });
  /** 返回是否真正写入完成：并发的第二次点击直接返回 false。 */
  const exclusive = async (work: () => Promise<void>) => {
    if (running.current) return false;
    running.current = true;
    try {
      await work();
      return true;
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code === 'REVISION_CONFLICT') await cmd.form.reload?.();
      throw error;
    } finally {
      running.current = false;
    }
  };
  return {
    ...cmd,
    disabled: cmd.form.locked || cmd.invalid || !!(cmd.form as CommandForm).blocked,
    submit: (values: Values, editableFields: readonly string[], send: ExitSend) =>
      exclusive(() => {
        const again = attempt(values, editableFields, send);
        return confirming(ask, send, () => again({}), again);
      }),
    /**
     * 结果未知后用户显式按原命令重发（同一键、同一报文，设计 §9.3）；只限不给 body 的提交点。
     * 台账回放的若是“要求确认”，确认后按原报文带确认项另起新命令。
     */
    replay: (send: ExitSend) =>
      exclusive(() => {
        const original = cmd.form.state?.command?.body;
        if (send.body || !original) throw new Error(ui.failed);
        const again = attempt(original, Object.keys(original), send);
        return confirming(ask, send, () => cmd.replay(sender(send, [], {})), again);
      }),
  };
}
export type ExitCommand = ReturnType<typeof useExitCommand>;
