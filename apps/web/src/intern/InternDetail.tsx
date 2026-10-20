import { Button, Popconfirm, Space, message } from 'antd';
import { useState } from 'react';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { usePermissions } from '../foundation/Permissions.js';
import { StaffDetail } from '../personnel/StaffDetail.js';
import { useInternCommand, useLatest } from './commands.js';
import { m } from './messages.js';
import { acceptBusiness, businesses, entriesFor, object, type Entry, type InternView, type Row } from './model.js';
import { RegularizeForm } from './RegularizeForm.js';
import { TerminateForm } from './TerminateForm.js';

/** 实习生详情复用人员详情（B40 同 B6），只在顶部挂入口（补证 R2d：实习转正 / 实习转正申请 / 结束实习）。 */
export function InternDetail({
  view,
  row,
  onClose,
  refresh,
}: {
  view: InternView;
  row: Row;
  onClose(): void;
  refresh(): Promise<unknown>;
}) {
  const permissions = usePermissions(object);
  const entries = entriesFor(view, row, permissions.snapshot.objects[object]);
  const [open, setOpen] = useState<Entry>();
  const done = async () => {
    setOpen(undefined);
    onClose();
    await refresh();
  };
  const form = { row, onClose: () => setOpen(undefined), onDone: done };
  const actions = (
    <Space wrap>
      {entries
        .filter((entry) => ['regularize', 'apply', 'terminate'].includes(entry))
        .map((entry) => (
          <Button key={entry} type={entry === 'regularize' ? 'primary' : 'default'} onClick={() => setOpen(entry)}>
            {m.entries[entry]}
          </Button>
        ))}
      {entries
        .filter((entry): entry is 'withdraw' | 'revoke' => entry === 'withdraw' || entry === 'revoke')
        .map((entry) => (
          <ApplicationAction key={entry} row={row} action={entry} onDone={done} />
        ))}
    </Space>
  );
  return (
    <>
      <StaffDetail employeeId={row.employeeId!} onClose={onClose} actions={actions} />
      {open === 'regularize' && <RegularizeForm {...form} application={false} />}
      {open === 'apply' && <RegularizeForm {...form} application />}
      {open === 'terminate' && <TerminateForm {...form} />}
    </>
  );
}

/** 实习转正中的申请：撤回（发起人）/ 撤销（HR）按单据 revision 提交空体，资格由服务端判定。 */
function ApplicationAction({
  row,
  action,
  onDone,
}: {
  row: Row;
  action: 'withdraw' | 'revoke';
  onDone(): Promise<void>;
}) {
  const read = useLatest(`${businesses}/${row.id}`, {});
  const cmd = useInternCommand(businesses, { id: row.id, revision: row.revision, baseline: {}, read }, action);
  const run = async () => {
    try {
      await cmd.submit({}, [], {
        path: `${businesses}/${row.id}/${action}`,
        body: () => ({}),
        accept: (raw, sent) =>
          acceptBusiness(raw, { employeeId: row.employeeId!, kind: 'intern_regularization', sent, id: row.id }),
      });
      void message.success(m.success[action]);
      await onDone();
    } catch {
      // 拒绝 / 冲突 / 结果未知由内核状态条显示
    }
  };
  const locked = cmd.disabled;
  return (
    <Space direction="vertical">
      <Popconfirm
        title={action === 'withdraw' ? m.withdrawConfirm : m.revokeConfirm}
        okText={m.confirm}
        cancelText={m.cancel}
        disabled={locked}
        onConfirm={() => void run()}
      >
        <Button danger={action === 'revoke'} loading={cmd.form.busy} disabled={locked}>
          {m.entries[action]}
        </Button>
      </Popconfirm>
      <CommandStatus submission={cmd.form} />
    </Space>
  );
}
