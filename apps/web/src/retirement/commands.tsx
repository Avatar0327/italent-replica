import { Button, Modal, Popconfirm, Space } from 'antd';
import { useRef } from 'react';
import type { Command } from '../foundation/client.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import type { Latest } from '../foundation/forms/store.js';
import type { CommandForm } from '../foundation/forms/useCommandForm.js';
import { projectFields, sameValue, type Values } from '../foundation/forms/values.js';
import { useApiClient } from '../foundation/Session.js';
import { useDirectApi } from '../part-time/direct-api.js';
import { m } from './messages.js';
import { confirmationOf, type Confirmation, type Extra } from './model.js';

type Api = ReturnType<typeof useApiClient>;
/** 读对象并核对标识与 revision（写后回读、单据重读共用）。 */
export async function readObject(api: Api, path: string, id: string, verify?: (latest: Values) => void) {
  const latest = await api.request<Values>(path);
  if (latest.id !== id || !Number.isSafeInteger(latest.revision)) throw new Error(m.invalidReceipt);
  verify?.(latest);
  return Number(latest.revision);
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

export interface Send {
  path: string;
  method?: 'POST' | 'PATCH';
  /** values = 内核最新全量里当前可提交的字段 + 人工修改的字段；extra = 预览 / 二次确认得到的确认项，由调用方决定放在哪。 */
  body(values: Values, extra: Extra): Values;
  /** 回执校验用实际提交的 command.revision；不符抛错，内核按结果未知锁定。返回写后回读的对象。 */
  accept(raw: Values, sent: number): { path: string; id: string; revision: number; verify?(latest: Values): void };
  /** 明确拒绝后重读；409 revision 冲突仍由内核展示差异、显式确认。 */
  rejected?(): Promise<void>;
}

/**
 * 一个提交点（恢复槽 = 资源 + 员工 / 申请 id，动作进上下文）：409 冲突、结果未知、明确拒绝都交内核（F-123，DEC-473）。
 * 服务端要求二次确认时（在途调动令牌 / 撤销超编）先弹确认，确认后带确认项在同一恢复槽、同一命令上下文里重提；
 * 被拒的命令已确定没有写入，重提是新命令（内容不同），基线与 revision 沿用原槽。结构同 intern/commands.tsx，
 * 区别是确认项交给 body 放位置（退休新建放 exit.pendingTransferAck，撤销放顶层 confirmed），并可预置预览令牌。
 */
export function useRetireCommand(
  resource: string,
  target: { id: string; revision: number | undefined; baseline: Values; read: () => Promise<Latest> },
  action: string,
  refresh: () => Promise<unknown>,
) {
  const direct = useDirectApi();
  const api = useApiClient();
  const snapshot = { id: target.id, revision: target.revision ?? -1, values: target.baseline };
  const cmd = useConflictCommand(resource, snapshot, target.read, { action });
  // 同一提交点只跑一个提交循环：连点或确认框打开期间再点不会把锁定中的原命令当作失败显示
  const running = useRef(false);
  const settle = async (check: ReturnType<Send['accept']>) => {
    try {
      if ((await readObject(api, check.path, check.id, check.verify)) < check.revision)
        throw new Error(m.invalidReceipt);
      await refresh();
    } catch {
      throw new Error(m.unconfirmed);
    }
  };
  return {
    ...cmd,
    /** 处理中 / 结果未知 / 冲突、对象标识无效，或本员工别的入口有未确认命令（forAction blocked）：不能提交。 */
    disabled: cmd.form.locked || cmd.invalid || !!(cmd.form as CommandForm).blocked,
    async submit(values: Values, editableFields: readonly string[], send: Send, start: Extra = {}) {
      // 返回是否真正写入完成：并发的第二次点击直接返回 false，调用方不得据此提示成功
      if (running.current) return false;
      running.current = true;
      try {
        let extra = start;
        for (;;) {
          try {
            await cmd.run({
              values,
              editableFields,
              send: async ({ edited, command }: { edited: Values; command: Command<Values> }) => {
                // 未改的可提交字段取最新全量：重读后服务端的新值不会被打开时的旧值覆盖
                const body = send.body({ ...projectFields(cmd.full, editableFields), ...edited }, extra);
                const raw = await direct(send.path, send.method ?? 'POST', { ...command, body });
                await settle(send.accept(raw, command.revision!));
                return { id: target.id };
              },
            });
            return true;
          } catch (error) {
            const confirmation = confirmationOf(error);
            // 同一确认项已带上仍被要求确认：不再循环，按拒绝显示
            const repeated = Object.entries(confirmation?.extra ?? {}).every(([key, value]) =>
              sameValue(extra[key as keyof Extra], value),
            );
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
export type RetireCommand = ReturnType<typeof useRetireCommand>;

/** 空体单据动作（提交 / 撤回）：确认后提交；拒绝 / 冲突 / 结果未知由内核状态条显示。 */
type ActionProps = { cmd: RetireCommand; label: string; title: string; run(): unknown };
export function ConfirmAction({ cmd, label, title, run }: ActionProps) {
  return (
    <Space direction="vertical">
      <Popconfirm title={title} okText={m.confirm} cancelText={m.cancel} disabled={cmd.disabled} onConfirm={run}>
        <Button loading={cmd.form.busy} disabled={cmd.disabled}>
          {label}
        </Button>
      </Popconfirm>
      <CommandStatus submission={cmd.form} />
    </Space>
  );
}
