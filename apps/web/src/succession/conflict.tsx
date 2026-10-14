import { Button, Popconfirm, type ButtonProps } from 'antd';
import type { Command } from '../foundation/client.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import type { Latest, Values } from '../foundation/forms/store.js';
import { ui } from '../foundation/messages.js';
import { useApiClient } from '../foundation/Session.js';
import { s } from './messages.js';
import { deleteReceipt } from './rules.js';

/** 页面手里的对象快照：values 是全量 DTO（不只是表单字段），提交时未改项从这里取。 */
export interface Snapshot {
  id?: string;
  revision: number;
  values: Values;
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

/**
 * 继任页面冲突恢复的唯一入口（DEC-431①）：五处表单与两处删除都走这里，规则一致。
 * - 键带对象 id 与版本：409 后关闭弹窗、刷新列表，重开时拿到新版本即是新键，旧锁不再挡住保存；
 *   新建没有版本，键就是资源路径本身（与 CreateEntry 的在途新建检查同一个键）。
 * - 弹窗内“重读最新版本”读回全量，核对差异后继续编辑；提交时只有用户改过的字段（edited）取表单值，
 *   其余（包括表单里没有的字段）取 full（读回的最新全量），不拿打开时的旧值覆盖别人的修改。
 * - 本地校验（必填、上限）要在 run 之前抛出：send 里抛的错会被内核判为结果未知并锁住。
 */
export function useConflictCommand(resource: string, current: Snapshot, read?: () => Promise<Latest>) {
  const api = useApiClient();
  const command = useCommandForm(current.id === undefined ? resource : `${resource}#${current.id}@${current.revision}`);
  const full = command.state?.latest?.values ?? current.values;
  const reload = read && current.id !== undefined ? () => command.reread(read) : undefined;
  const run = async ({ values, editableFields, send }: Run) => {
    const outcome = await command.submit({
      values,
      baseline: current.values,
      editableFields,
      revision: current.revision,
      businessId: current.id,
      patchOnly: current.id !== undefined,
      send: (request) => send({ edited: request.body, command: request }),
    });
    if (outcome.status !== 'done') throw outcome.error ?? new Error(ui.failed);
    command.clear();
  };
  return {
    form: { ...command, reload },
    /** 最新全量：重读并核对后是读回的那份，否则是打开时的快照。 */
    full,
    /** 冲突或结果未知：关闭时调用方应刷新来源，重开即按新版本解锁（DEC-067 先回查再重提）。 */
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
  path: string;
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
  path,
  row,
  settled,
  button,
  title = s.deleteConfirm,
}: DeleteProps & { row: { id: string; revision: number } }) {
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
