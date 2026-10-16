import { Popconfirm } from 'antd';
import type { ReactNode } from 'react';
import { useApiClient } from '../foundation/Session.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { collection, receipt, type Row } from './model.js';
import { refreshAfter, request, requireWrite, useEntryAccess, useEntryCommand } from './commands.js';
import { m } from './messages.js';

export function DeleteBubble({
  row,
  open,
  close,
  refresh,
  children,
}: {
  row: Row;
  open: boolean;
  close(): void;
  refresh(): Promise<void>;
  children: ReactNode;
}) {
  const api = useApiClient();
  const p = useEntryAccess();
  const cmd = useEntryCommand(row, 'delete');
  return (
    <Popconfirm
      open={open}
      trigger={[]}
      title={m.deleteHint}
      description={<CommandStatus submission={cmd.form} labels={m.fields} />}
      okText={m.yes}
      cancelText={m.no}
      placement="left"
      okButtonProps={{ 'aria-label': m.yes, disabled: !p.remove || cmd.form.locked, loading: cmd.form.busy }}
      cancelButtonProps={{ disabled: cmd.form.busy }}
      onCancel={close}
      onConfirm={async () => {
        try {
          requireWrite(p.remove);
          await cmd.run({}, [], async (command) => {
            receipt(
              await request(api, `${collection}/${row.id}`, { method: 'DELETE', command }),
              row,
              command,
              'delete',
            );
            await refreshAfter(refresh);
          });
          close();
        } catch {
          /* 错误与原单恢复由持久命令槽显示，确认气泡保持打开。 */
        }
      }}
    >
      <span>{children}</span>
    </Popconfirm>
  );
}
