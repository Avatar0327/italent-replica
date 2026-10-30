import { Modal } from 'antd';
import { useRef } from 'react';
import type { Command } from '../foundation/client.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import type { Latest } from '../foundation/forms/store.js';
import type { CommandForm } from '../foundation/forms/useCommandForm.js';
import { projectFields, sameValue, type Values } from '../foundation/forms/values.js';
import { useApiClient } from '../foundation/Session.js';
import { confirmationOf, type Confirmation } from '../intern/model.js';
import { useDirectApi } from '../part-time/direct-api.js';
import { m } from './messages.js';

export interface Readback {
  path: string;
  id: string;
  /** 回读的 revision 下限：低于它说明读到的不是本次写入之后的版本。 */
  revision: number;
  verify?(latest: Values): void;
}
export interface Send {
  /** 编辑试用期是 PUT（共享客户端）；其余入口 POST，经局部通道保留 details.reason。 */
  method?: 'POST' | 'PUT';
  path: string;
  /** POST /regularizations 不读 If-Match（员工 revision 逐人在请求体里）。 */
  ifMatch?: boolean;
  body(values: Values): Values;
  /** 回执校验用实际提交的 revision；不符抛错，内核按结果未知锁定。不返回回读对象时只刷新列表（批量）。 */
  accept(raw: Values, sent: number): Readback | undefined;
  /** 明确拒绝后重读；409 revision 冲突由内核展示差异、显式确认。 */
  rejected?(): Promise<void>;
}
export interface Target {
  id?: string;
  revision: number | undefined;
  baseline: Values;
  read?: () => Promise<Latest>;
  /** 批量转正：逐人钉住恢复槽，结果未知时这些员工的单人入口也锁定。 */
  objects?: readonly { id: string; revision: number }[];
}

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

/**
 * 一个提交点（resource + 员工 / 单据 + 动作）接 F-123 内核（DEC-473）：409 冲突、结果未知、明确拒绝都交内核；
 * CONFIRMATION_REQUIRED 先确认，再以同一恢复槽、同一命令上下文带 confirmed 重提（同实习 useInternCommand）。
 * 写后回读确认 revision 不低于回执，回读失败保持未知锁，不提示成功。
 */
export function useProbationCommand(resource: string, target: Target, action: string, refresh: () => Promise<unknown>) {
  const post = useDirectApi();
  const api = useApiClient();
  const snapshot = target.objects
    ? { revision: 0, values: target.baseline, objects: target.objects }
    : { id: target.id, revision: target.revision ?? -1, values: target.baseline };
  const cmd = useConflictCommand(resource, snapshot, target.read, { action });
  const running = useRef(false);
  const settle = async (check: Readback | undefined) => {
    try {
      if (check) {
        const latest = await api.request<Values>(check.path);
        if (latest.id !== check.id || !(Number(latest.revision) >= check.revision)) throw new Error(m.invalidReceipt);
        check.verify?.(latest);
      }
      await refresh();
    } catch {
      throw new Error(m.unconfirmed);
    }
  };
  const transmit = (send: Send, command: Command<Values>) => {
    const sent = send.ifMatch === false ? { ...command, revision: undefined } : command;
    return send.method === 'PUT'
      ? api.request<Values>(send.path, { method: 'PUT', command: sent })
      : post(send.path, 'POST', sent);
  };
  return {
    ...cmd,
    disabled: cmd.form.locked || cmd.invalid || !!(cmd.form as CommandForm).blocked,
    /** 返回是否真正写入完成：并发的第二次点击直接返回 false，调用方不得据此提示成功。 */
    async submit(values: Values, editableFields: readonly string[], send: Send) {
      if (running.current) return false;
      running.current = true;
      let extra: Values = {};
      try {
        for (;;) {
          try {
            await cmd.run({
              values,
              editableFields,
              send: async ({ edited, command }) => {
                // 未改的可提交字段取最新全量：重读后服务端的新值不会被打开时的旧值覆盖
                const body = send.body({ ...projectFields(cmd.full, editableFields), ...edited });
                const raw = await transmit(send, { ...command, body: { ...body, ...extra } });
                await settle(send.accept(raw, command.revision!));
                return { id: target.id ?? resource };
              },
            });
            return true;
          } catch (error) {
            const confirmation = confirmationOf(error);
            const repeated = Object.entries(confirmation?.extra ?? {}).every(([k, v]) => sameValue(extra[k], v));
            if (!confirmation || repeated || !(await ask(confirmation))) throw error;
            extra = { ...extra, ...confirmation.extra };
          }
        }
      } catch (error) {
        const status = (error as { status?: number } | undefined)?.status;
        if (status && [403, 409, 422].includes(status)) {
          if ((error as { code?: string }).code === 'REVISION_CONFLICT') await cmd.form.reload?.();
          else await send.rejected?.();
        }
        throw error;
      } finally {
        running.current = false;
      }
    },
  };
}
export type ProbationCommand = ReturnType<typeof useProbationCommand>;
