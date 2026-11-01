import { Modal, message } from 'antd';
import { useCallback, useRef, useState } from 'react';
import type { Command } from '../foundation/client.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { CommandForm } from '../foundation/forms/useCommandForm.js';
import type { Latest } from '../foundation/forms/store.js';
import { projectFields, sameValue, type Values } from '../foundation/forms/values.js';
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

/** 离职单的打开基线与重读（GET /exits/:id）：表单值按详情投影，缺键（被裁剪）按空。 */
export function useExitRead(id: string) {
  const api = useApiClient();
  return useCallback(async (): Promise<Latest> => {
    const latest = await readObject(api, slotKey(exits, id), id);
    return { id, revision: Number(latest.revision), values: detailValues(latest) };
  }, [api, id]);
}

export const ask = (title: string, content: string) =>
  new Promise<boolean>((resolve) =>
    Modal.confirm({
      title,
      content,
      okText: x.confirm,
      cancelText: x.cancel,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    }),
  );

/** 表单提交：字段校验错误留在表单项上，其余（本地校验 / 拒绝）显示在表单上方；写入完成后提示并关闭。 */
export function useFormSubmit(locked: boolean, run: () => Promise<boolean | undefined>, onClose: () => void) {
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
  /** values = 最新全量里可提交的字段 + 人工修改的字段；confirm = 服务端要求确认后追加的确认项；edited = 人工修改的字段。 */
  body(values: Values, confirm: Values, edited: Values): Values;
  /** 回执校验（用实际提交的 revision）；返回写后回读的对象，不需要回读时返回 undefined。 */
  accept(raw: Values, sent: number | undefined): { path: string; id: string; revision: number } | undefined;
  /** false：服务端要求确认也不进确认循环（F-240 超上限时后端不给令牌，不得出现确认提交）。 */
  confirmable?: boolean;
  /** 不带 If-Match（批量：版本在请求体里逐条给）。 */
  noRevision?: boolean;
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
  return {
    ...cmd,
    disabled: cmd.form.locked || cmd.invalid || !!(cmd.form as CommandForm).blocked,
    /** 返回是否真正写入完成：并发的第二次点击直接返回 false。 */
    async submit(values: Values, editableFields: readonly string[], send: ExitSend) {
      if (running.current) return false;
      running.current = true;
      try {
        let confirm: Values = {};
        for (;;) {
          try {
            await cmd.run({
              values,
              editableFields,
              send: async ({ edited, command }: { edited: Values; command: Command<Values> }) => {
                const body = send.body({ ...projectFields(cmd.full, editableFields), ...edited }, confirm, edited);
                const sent = send.noRevision ? undefined : command.revision;
                const raw = await post(send.path, send.method, { ...command, revision: sent, body });
                await settle(send.accept(raw, sent));
                return { id: target.id ?? resource };
              },
            });
            return true;
          } catch (error) {
            const confirmation = send.confirmable === false ? undefined : confirmationOf(error);
            const repeated = Object.entries(confirmation?.extra ?? {}).every(([k, v]) => sameValue(confirm[k], v));
            if (!confirmation || repeated || !(await ask(x.confirmTitle, confirmation.message))) throw error;
            confirm = { ...confirm, ...confirmation.extra };
          }
        }
      } catch (error) {
        if ((error as { code?: string } | undefined)?.code === 'REVISION_CONFLICT') await cmd.form.reload?.();
        throw error;
      } finally {
        running.current = false;
      }
    },
  };
}
export type ExitCommand = ReturnType<typeof useExitCommand>;
