import { Button, Popconfirm, type ButtonProps } from 'antd';
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Command } from '../foundation/client.js';
import { FormCommands, useCommandForm } from '../foundation/forms/useCommandForm.js';
import type { Latest, Values } from '../foundation/forms/store.js';
import { ui } from '../foundation/messages.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { s } from './messages.js';
import { deleteReceipt } from './rules.js';

/** 页面手里的对象快照：values 是全量 DTO（不只是表单字段），提交时未改项从这里取。 */
export interface Snapshot {
  id?: string;
  revision: number;
  values: Values;
  /** 一个命令涉及多个对象（批量结束）时逐个列出：键由各对象版本组成，结果未知时逐个钉住。 */
  objects?: readonly { id: string; revision: number }[];
}
interface Sending {
  /** 用户真正改过的可编辑字段（相对基线）；未改项由调用方从 full 取。 */
  edited: Values;
  command: Command<Values>;
}
export interface Run {
  values: Values;
  editableFields: readonly string[];
  send(request: Sending): Promise<{ id: string }>;
}

/** 对象（不含版本）→ 结果未知的命令键。挂在页面根部，与表单状态同寿命：关弹窗、刷新列表都不丢。 */
const Pins = createContext<Map<string, string> | undefined>(undefined);
/** 继任页面的命令 Provider：表单状态之外再持有结果未知的钉住表（F-123）。 */
export function ConflictCommands({ children }: { children: ReactNode }) {
  const [pins] = useState(() => new Map<string, string>());
  return (
    <FormCommands>
      <Pins.Provider value={pins}>{children}</Pins.Provider>
    </FormCommands>
  );
}

/**
 * 继任页面冲突恢复的唯一入口（DEC-431①）：五处表单与两处删除都走这里，规则一致。
 * - 409 冲突：键带对象 id 与版本，关闭弹窗、刷新列表后重开拿到新版本即是新键，旧锁不再挡住保存；
 *   新建没有版本，键就是资源路径本身（与 CreateEntry 的在途新建检查同一个键）。
 * - 结果未知（F-123）：写入可能已成功、版本已变，换键就等于换新命令再写一次。所以提交时先按对象（不含版本）
 *   钉住当前键，结果未知就一直钉着，关闭重开、读回新版本也仍是原命令、仍锁定，直到页面重新加载；其他结果解钉。
 * - 弹窗内“重读最新版本”读回全量，核对差异后继续编辑；提交时只有用户改过的字段（edited）取表单值，
 *   其余（包括表单里没有的字段）取 full（读回的最新全量），不拿打开时的旧值覆盖别人的修改。
 * - 本地校验（必填、上限）要在 run 之前抛出：send 里抛的错会被内核判为结果未知并锁住。
 */
export function useConflictCommand(resource: string, current: Snapshot, read?: () => Promise<Latest>) {
  const api = useApiClient();
  const session = useSession();
  const pins = useContext(Pins);
  if (!pins) throw new Error('ConflictCommands provider required');
  const objects = current.objects ?? (current.id === undefined ? [] : [{ id: current.id, revision: current.revision }]);
  const scope = (name: string) => JSON.stringify([session.tenantId, session.identityKey, name]);
  const scopes = objects.length ? objects.map((item) => scope(`${resource}#${item.id}`)) : [scope(resource)];
  const versioned = objects.length
    ? `${resource}#${objects.map((item) => `${item.id}@${item.revision}`).join(',')}`
    : resource;
  const key = scopes.map((name) => pins.get(name)).find((pinned) => pinned !== undefined) ?? versioned;
  const command = useCommandForm(key);
  const full = command.state?.latest?.values ?? current.values;
  const reload = read && current.id !== undefined ? () => command.reread(read) : undefined;
  const run = async ({ values, editableFields, send }: Run) => {
    // 先钉再发：提交途中关掉弹窗，重开时也落在同一个键上。
    scopes.forEach((name) => pins.set(name, key));
    const outcome = await command.submit({
      values,
      baseline: current.values,
      editableFields,
      revision: current.revision,
      businessId: current.id,
      patchOnly: current.id !== undefined,
      send: (request) => send({ edited: request.body, command: request }),
    });
    if (outcome.status !== 'unknown') scopes.forEach((name) => pins.delete(name));
    if (outcome.status !== 'done') throw outcome.error ?? new Error(ui.failed);
    command.clear();
  };
  return {
    form: { ...command, reload },
    /** 最新全量：重读并核对后是读回的那份，否则是打开时的快照。 */
    full,
    /** 冲突或结果未知：关闭时调用方应刷新来源（DEC-067 先回查再重提）；冲突重开即按新版本解锁，结果未知仍锁定。 */
    stale: command.status === 'conflict' || command.status === 'unknown',
    run,
    remove: (path: string) =>
      run({
        values: {},
        editableFields: [],
        send: async ({ command: request }) =>
          deleteReceipt(await api.request(path, { method: 'DELETE', command: { ...request, body: undefined } })),
      }),
  };
}

interface DeleteProps {
  /** 集合路径：删除发到 {base}/{row.id}。 */
  base: string;
  row?: { id: string; revision: number };
  /** 删除收尾（成功或失败）都回调：调用方刷新列表，冲突后重选即按新版本删除。 */
  settled(error?: unknown): void;
  button?: ButtonProps;
  title?: string;
}
/** 删除按钮：未选中时只渲染禁用按钮；选中后经 useConflictCommand 发删除命令。 */
export function DeleteButton(props: DeleteProps) {
  return props.row ? (
    <ArmedDelete {...props} row={props.row} />
  ) : (
    <Button {...props.button} disabled>
      {s.delete}
    </Button>
  );
}
function ArmedDelete({
  base,
  row,
  settled,
  button,
  title = s.deleteConfirm,
}: DeleteProps & { row: { id: string; revision: number } }) {
  const path = `${base}/${row.id}`;
  const writer = useConflictCommand(path, { id: row.id, revision: row.revision, values: {} });
  const confirm = async () => {
    try {
      await writer.remove(path);
      settled();
    } catch (error) {
      settled(error);
    }
  };
  return (
    <Popconfirm title={title} disabled={writer.form.locked} onConfirm={confirm}>
      <Button {...button} disabled={writer.form.locked} loading={writer.form.busy}>
        {s.delete}
      </Button>
    </Popconfirm>
  );
}
