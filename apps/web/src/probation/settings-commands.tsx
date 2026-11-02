// FE-R2c1b 行内命令（字典启停、规则复制 / 启停 / 删除）共用的确认按钮与结果收口。
import { Button, Popconfirm, message } from 'antd';
import { rejectionMessage, type Command } from '../foundation/client.js';
import type { useConflictCommand } from '../foundation/forms/ConflictCommands.js';
import type { Values } from '../foundation/forms/store.js';
import { s } from './settings-messages.js';

type Writer = ReturnType<typeof useConflictCommand>;
/**
 * 结果未知：可能已写入，保持锁定，不提示也不刷新，等用户刷新回查（DEC-067）；
 * 明确拒绝与版本冲突：提示原因、解锁并刷新列表，用户按最新数据重新操作。
 */
export async function perform(
  writer: Writer,
  values: Values,
  done: string,
  reload: () => void,
  send: (command: Command<Values>) => Promise<{ id: string }>,
) {
  try {
    await writer.run({ values, editableFields: Object.keys(values), send: ({ command }) => send(command) });
    void message.success(done);
  } catch (error) {
    if (writer.form.peek()?.status === 'unknown') return;
    void message.error(rejectionMessage(error));
    writer.form.clear();
  }
  reload();
}

export function Confirm(props: {
  title: string;
  label: string;
  disabled: boolean;
  danger?: boolean;
  onConfirm(): Promise<void>;
}) {
  return (
    <Popconfirm
      title={props.title}
      okText={s.confirm}
      cancelText={s.cancel}
      disabled={props.disabled}
      onConfirm={() => void props.onConfirm()}
    >
      <Button type="link" danger={props.danger} disabled={props.disabled}>
        {props.label}
      </Button>
    </Popconfirm>
  );
}
