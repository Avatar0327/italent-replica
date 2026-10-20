import { Button, Popconfirm, Space, message } from 'antd';
import { useState } from 'react';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { slotKey } from '../foundation/forms/slot.js';
import { usePermissions } from '../foundation/Permissions.js';
import { StaffDetail } from '../personnel/StaffDetail.js';
import { useBusinessRead, useInternCommand } from './commands.js';
import { m } from './messages.js';
import {
  acceptBusiness,
  businesses,
  entriesFor,
  interns,
  object,
  type Entry,
  type InternView,
  type Row,
} from './model.js';
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
  refresh(applicationId?: string): Promise<unknown>;
}) {
  const permissions = usePermissions(object);
  const entries = entriesFor(view, row, permissions.snapshot.objects[object]);
  const [open, setOpen] = useState<Entry>();
  // 写后回读与列表刷新已在提交完成路径里确认（commands.tsx settle），这里只关闭表单与详情
  const done = () => {
    setOpen(undefined);
    onClose();
  };
  const form = { row, onClose: () => setOpen(undefined), onDone: done, refresh };
  const actions = (
    <Space wrap>
      {entries
        .filter(
          (entry): entry is 'regularize' | 'apply' | 'terminate' =>
            entry === 'regularize' || entry === 'apply' || entry === 'terminate',
        )
        .map((entry) => (
          <Button key={entry} type={entry === 'regularize' ? 'primary' : 'default'} onClick={() => setOpen(entry)}>
            {m.entries[entry]}
          </Button>
        ))}
      {entries
        .filter((entry): entry is 'withdraw' | 'revoke' => entry === 'withdraw' || entry === 'revoke')
        .map((entry) => (
          <ApplicationAction key={entry} row={row} action={entry} onDone={done} refresh={refresh} />
        ))}
    </Space>
  );
  return (
    <>
      <StaffDetail employeeId={row.employeeId!} onClose={onClose} actions={actions} />
      {open === 'regularize' && <RegularizeForm {...form} />}
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
  refresh,
}: {
  row: Row;
  action: 'withdraw' | 'revoke';
  onDone(): void;
  refresh(): Promise<unknown>;
}) {
  const read = useBusinessRead(row.id);
  // 与申请第二步共用员工恢复槽；提交结果未知时撤回 / 撤销也不能绕开锁。
  const target = {
    id: row.employeeId!,
    revision: row.revision,
    baseline: {},
    read: async () => ({ ...(await read()), id: row.employeeId! }),
  };
  const cmd = useInternCommand(interns, target, `${action}/${row.id}`, refresh);
  const run = async () => {
    try {
      const done = await cmd.submit({}, [], {
        path: `${slotKey(businesses, row.id)}/${action}`,
        body: () => ({}),
        accept: (raw, sent) => {
          const expected = { employeeId: row.employeeId!, kind: 'intern_regularization', sent, id: row.id };
          const receipt = acceptBusiness(raw, expected);
          return { path: slotKey(businesses, row.id), id: row.id, revision: Number(receipt.revision) };
        },
      });
      if (!done) return;
      void message.success(m.success[action]);
      onDone();
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
