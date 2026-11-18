import { Button, Popconfirm, Tooltip, type ButtonProps } from 'antd';
import { ApiError } from '../foundation/client.js';
import { useConflictCommand, validObject } from '../foundation/forms/ConflictCommands.js';
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
  /** 选中行 id / 版本无效时悬停的原因提示，由调用方按对象给出；不传则只禁用（设置页字典沿用原行为）。 */
  invalidHint?: string;
}
/**
 * F-145（DEC-431①）：继任模块写入口的统一前置校验。本次实际要组包（路径、If-Match、请求体）的对象逐条过内核
 * validObject，有无效的按确定性拒绝（400）抛出：在 writer.run 之前，不进内核、不发请求，表单显示 message、草稿保留。
 */
export function requireObjects(items: readonly { id?: string; revision?: number }[], message: string) {
  if (!items.every(validObject)) throw new ApiError(400, 'VALIDATION_FAILED', 'fields', message);
}
/**
 * 删除按钮（冲突恢复命令已上收进内核 foundation/forms/ConflictCommands，F-142）：未选中，或选中行的 id / 版本
 * 缺失、无效（如被字段权限裁剪）时只渲染禁用按钮，不进内核、不发请求；其余经 useConflictCommand 发删除命令。
 */
export function DeleteButton(props: DeleteProps) {
  if (deletable(props.row)) return <ArmedDelete {...props} row={props.row} />;
  const button = (
    <Button {...props.button} disabled>
      {s.delete}
    </Button>
  );
  // F-145：选中行无效且调用方给了提示时说明原因；未选中、或调用方未给提示（字典）照旧只禁用。
  return props.row && props.invalidHint ? <Tooltip title={props.invalidHint}>{button}</Tooltip> : button;
}
const deletable = (row?: DeleteProps['row']): row is NonNullable<DeleteProps['row']> => !!row && validObject(row);
function ArmedDelete({
  base,
  row,
  settled,
  button,
  title = s.deleteConfirm,
}: DeleteProps & { row: { id: string; revision: number } }) {
  const api = useApiClient();
  const path = `${base}/${row.id}`;
  // 删除与编辑、批量结束共用同一对象的恢复槽，动作记在槽上下文（F-147）：任一动作结果未知时删除同样锁定，反之亦然。
  const writer = useConflictCommand(base, { id: row.id, revision: row.revision, values: {} }, undefined, {
    action: 'delete',
  });
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
