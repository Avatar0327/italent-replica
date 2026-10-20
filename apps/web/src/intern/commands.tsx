import { Modal } from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, type Command } from '../foundation/client.js';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { slotKey } from '../foundation/forms/slot.js';
import { FormCommands, type CommandForm } from '../foundation/forms/useCommandForm.js';
import type { Latest } from '../foundation/forms/store.js';
import { projectFields, sameValue, type Values } from '../foundation/forms/values.js';
import { useApiClient } from '../foundation/Session.js';
import { useDirectApi } from '../part-time/direct-api.js';
import { m } from './messages.js';
import { apiRoot, businesses, confirmationOf, type Confirmation } from './model.js';

/** 页面根部：未确认命令的存储（F-123 内核，DEC-473），详情与表单关闭重开后仍在。 */
export function InternCommands({ children }: { children: ReactNode }) {
  return <FormCommands>{children}</FormCommands>;
}

export const employeePath = (employeeId: string) => slotKey(`${apiRoot}/employees`, employeeId);

type Api = ReturnType<typeof useApiClient>;
/** 读对象并核对标识与 revision（写后回读、申请单重读共用）。 */
async function readObject(api: Api, path: string, id: string) {
  const latest = await api.request<{ id?: unknown; revision?: unknown }>(path);
  if (latest.id !== id || !Number.isSafeInteger(latest.revision)) throw new Error(m.invalidReceipt);
  return Number(latest.revision);
}

/** 申请单（提交 / 撤回 / 撤销）的最新版本：只有 revision，没有可编辑字段。 */
export function useBusinessRead(id: string) {
  const api = useApiClient();
  return async (): Promise<Latest> => ({
    id,
    revision: await readObject(api, slotKey(businesses, id), id),
    values: {},
  });
}

/** 当前主职任职（记录链 isCurrent + primary）；字段按可见字段裁剪后缺键，投影时为空。 */
async function currentRecord(api: Api, employeeId: string) {
  for (let page = 1; page <= 5; page += 1) {
    const path = `${employeePath(employeeId)}/records?page=${page}&pageSize=200`;
    const { items } = await api.request<{ items: Values[] }>(path);
    const current = items.find((item) => item.isCurrent === true && item.serviceType === 'primary');
    if (current || items.length < 200) return current;
  }
  throw new Error(m.invalidReceipt);
}

/** 一致快照的读取次数上限：期间每次都有人改了此员工，就报错交用户重试，不拿不一致的快照。 */
const SNAPSHOT_ATTEMPTS = 3;

/**
 * 员工 revision 与当前主职任职的一致快照（第 2 轮 P2-R2-1）：任职前后各读一次员工 revision，两次相同才接受
 * ——此员工的任何任职写入都会让员工 revision 加一，revision 没变就说明读到的任职属于这个版本；
 * 不同就整份丢弃重读。不并行读：并行时可能拼出“新 revision + 旧任职字段”，用新 If-Match 发旧值。
 */
async function consistentSnapshot(api: Api, employeeId: string) {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await readObject(api, employeePath(employeeId), employeeId);
    const record = await currentRecord(api, employeeId);
    if ((await readObject(api, employeePath(employeeId), employeeId)) === before) return { revision: before, record };
  }
  // 机读码区分于业务拒绝；只读不写，不进命令内核，打开时由 PageState 显示原因并可重试
  throw new ApiError(409, 'SNAPSHOT_UNSTABLE', 'conflict', m.unstableSnapshot);
}

/**
 * 员工入口的打开基线与 409 重读共用这一个读取函数（claude_fe_rules b，DEC-431①）：员工 revision 作 If-Match，
 * 表单值由 project 按当前主职任职投影。默认带出的部门、汇报关系就是基线本身，不算人工修改；重读后交内核比较、回填。
 * 结束实习不带任职字段（withRecord = false），只读员工 revision。
 */
export function useEmployeeRead(employeeId: string, project: (record?: Values) => Values, withRecord: boolean) {
  const api = useApiClient();
  return useCallback(async (): Promise<Latest> => {
    const { revision, record } = withRecord
      ? await consistentSnapshot(api, employeeId)
      : { revision: await readObject(api, employeePath(employeeId), employeeId), record: undefined };
    return { id: employeeId, revision, values: project(record) };
  }, [api, employeeId, project, withRecord]);
}

/** 打开时读一次基线；读失败显示错误并可重试，读到之前不渲染表单（基线必须是真实值）。 */
export function useOpening(read: () => Promise<Latest>) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ attempt: number; data?: Latest; error?: unknown }>();
  useEffect(() => {
    let live = true;
    read().then(
      (data) => live && setState({ attempt, data }),
      (error: unknown) => live && setState({ attempt, error }),
    );
    return () => {
      live = false;
    };
  }, [read, attempt]);
  const current = state?.attempt === attempt ? state : undefined;
  return { data: current?.data, error: current?.error, retry: () => setAttempt((n) => n + 1) };
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
  /** values = 内核最新全量里当前可提交的字段 + 人工修改的字段（claude_fe_rules b）。 */
  body(values: Values): Values;
  /**
   * 回执校验：用实际提交的 command.revision；不符抛错，内核按结果未知锁定。
   * 返回写后回读的对象（路径、id、revision 下限）。
   */
  accept(raw: Values, sent: number): { path: string; id: string; revision: number };
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
  refresh: () => Promise<unknown>,
) {
  const post = useDirectApi();
  const api = useApiClient();
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
        await submitConfirmed(cmd.run, {
          id: target.id,
          send,
          values,
          editableFields,
          full: cmd.full,
          post: (raw) => post(send.path, 'POST', raw),
          // 写后回读与列表刷新是提交完成的一部分：失败按结果未知锁定，恢复槽保持钉住（P2-2）
          settle: async (check) => {
            try {
              if ((await readObject(api, check.path, check.id)) < check.revision) throw new Error(m.invalidReceipt);
              await refresh();
            } catch {
              throw new Error(m.unconfirmed);
            }
          },
          onConfirmation,
        });
        return true;
      } finally {
        running.current = false;
      }
    },
  };
}
export type InternCommand = ReturnType<typeof useInternCommand>;

type Run = ReturnType<typeof useConflictCommand>['run'];
interface Submitting {
  id: string;
  send: Send;
  values: Values;
  editableFields: readonly string[];
  full: Values;
  post(command: Command<Values>): Promise<Values>;
  settle(check: ReturnType<Send['accept']>): Promise<void>;
  onConfirmation?(confirmation: Confirmation): void;
}
async function submitConfirmed(run: Run, input: Submitting) {
  const { id, send, values, editableFields, full, post, settle, onConfirmation } = input;
  let extra: Values = {};
  for (;;) {
    try {
      await run({
        values,
        editableFields,
        send: async ({ edited, command }: { edited: Values; command: Command<Values> }) => {
          // 未改的可提交字段取最新全量：重读后服务端的新值不会被打开时的旧值覆盖
          const body = send.body({ ...projectFields(full, editableFields), ...edited });
          const raw = await post({ ...command, body: { ...body, ...extra } });
          await settle(send.accept(raw, command.revision!));
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
