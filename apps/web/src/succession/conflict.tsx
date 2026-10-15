import { Button, Popconfirm, type ButtonProps } from 'antd';
import { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import { useApiClient } from '../foundation/Session.js';
import { s } from './messages.js';
import { deleteReceipt } from './rules.js';

interface DeleteProps {
  /** 集合路径：删除发到 {base}/{row.id}。 */
  base: string;
  row?: { id: string; revision: number };
  /** 删除收尾（成功或失败）都回调：调用方刷新列表，冲突后重选即按新版本删除。 */
  settled(error?: unknown): void;
  button?: ButtonProps;
  title?: string;
}
/** 删除按钮（冲突恢复命令已上收进内核 foundation/forms/ConflictCommands，F-142）：未选中时只渲染禁用按钮；选中后经 useConflictCommand 发删除命令。 */
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
  const api = useApiClient();
  const path = `${base}/${row.id}`;
  // 删除与编辑共用同一对象的恢复槽（不按动作分键）：编辑结果未知时删除同样锁定，反之亦然。
  const writer = useConflictCommand(base, { id: row.id, revision: row.revision, values: {} });
  const confirm = async () => {
    try {
      await writer.run({
        values: {},
        editableFields: [],
        send: async ({ command }) =>
          deleteReceipt(await api.request(path, { method: 'DELETE', command: { ...command, body: undefined } })),
      });
      settled();
    } catch (error) {
      // 删除没有草稿可留：被拒后清掉条目，免得同一对象的编辑弹窗显示删除的错误。锁定状态内核会拒绝清除。
      writer.form.clear();
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
