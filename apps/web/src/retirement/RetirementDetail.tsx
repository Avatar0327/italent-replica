import { Alert, Button, Descriptions, Drawer, Input, Modal, Space, Table, Tabs, message } from 'antd';
import { useState } from 'react';
import { NameOf } from '../contracts/references.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { slotKey } from '../foundation/forms/slot.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useBusinessRead } from '../intern/commands.js';
import { refPaths } from '../part-time/references.js';
import { useRead } from '../part-time/useRead.js';
import { StaffDetail } from '../personnel/StaffDetail.js';
import { ConfirmAction, useRetireCommand } from './commands.js';
import { IntentionForm } from './IntentionForm.js';
import { m } from './messages.js';
import {
  acceptRetirement,
  apiRoot,
  cellValue,
  entriesFor,
  object,
  retirements,
  retireSlot,
  type Entry,
  type RetirementView,
  type Row,
} from './model.js';
import { RetireForm } from './RetireForm.js';

type DetailProps = { view: RetirementView; row: Row; onClose(): void; refresh(): Promise<unknown> };

/** 即将 / 过期未退休的员工行：复用人员详情（B6），顶部挂退休办理 / 退休申请 / 意向退休日期申请。 */
export function PersonDetail({ view, row, onClose, refresh }: DetailProps) {
  const permissions = usePermissions(object);
  const entries = entriesFor(view, row, permissions.snapshot.objects[object]);
  const [open, setOpen] = useState<Entry>();
  const done = () => {
    setOpen(undefined);
    onClose();
  };
  const form = { row, onClose: () => setOpen(undefined), onDone: done, refresh };
  const actions = (
    <Space wrap>
      {entries.map((entry) => (
        <Button key={entry} type={entry === 'retire' ? 'primary' : 'default'} onClick={() => setOpen(entry)}>
          {m.entries[entry]}
        </Button>
      ))}
    </Space>
  );
  return (
    <>
      <StaffDetail employeeId={row.employeeId!} onClose={onClose} actions={actions} />
      {open === 'retire' && <RetireForm {...form} mode="direct" />}
      {open === 'apply' && <RetireForm {...form} mode="application" />}
      {open === 'intention' && <IntentionForm {...form} />}
    </>
  );
}

/** 退休单详情（GET /retirements/:id）：动作取详情里的最新状态与 revision，列表行只用于打开。 */
export function RetirementDetail({ view, row, onClose, refresh }: DetailProps) {
  const result = useRead<Row>(slotKey(retirements, row.id!));
  const permissions = usePermissions(object);
  const detail = result.data;
  const entries = detail ? entriesFor(view, detail, permissions.snapshot.objects[object]) : [];
  const reload = async () => {
    await refresh();
    await result.reload();
  };
  const actions = entries
    .filter((entry): entry is BillEntry => entry === 'submit' || entry === 'withdraw' || entry === 'cancel')
    .map((entry) => <BillAction key={entry} row={detail!} action={entry} refresh={reload} />);
  return (
    <Drawer open width={760} title={detail?.name ? String(detail.name) : m.title} onClose={onClose}>
      {result.error ? (
        <PageState kind="error" error={result.error} retry={result.refresh} />
      ) : (
        <>
          {actions.length > 0 && (
            <Space wrap className="retirement-actions">
              {actions}
            </Space>
          )}
          {detail && (
            <Tabs
              items={[
                { key: 'record', label: m.tabs.record, children: <RecordTab detail={detail} /> },
                { key: 'handover', label: m.tabs.handover, children: handover },
                { key: 'versions', label: m.tabs.versions, children: <VersionsTab detail={detail} /> },
              ]}
            />
          )}
        </>
      )}
    </Drawer>
  );
}

// 后端未开放退休交接子流程（GET /exits/:id/handover 只受理离职单）：页签按 R2f B24 只读口径，只显示缺口
const handover = <Alert type="info" showIcon message={m.handoverGap} />;
const references: Record<string, string> = {
  departmentId: refPaths.departmentId!,
  positionId: refPaths.positionId!,
  handoverEmployeeId: refPaths.directManagerId!,
};
const recordFields = (
  'name code departmentId positionId expectedRetirementDate retireType lastWorkDate ' +
  'effectiveDate mode status handoverEmployeeId reEmployed'
).split(' ');
/** 被裁剪的字段缺键，照常显示占位（claude_fe_rules d）。 */
function RecordTab({ detail }: { detail: Row }) {
  const cancellation = detail.cancellation;
  return (
    <>
      <Descriptions
        size="small"
        column={2}
        items={recordFields.map((key) => ({
          key,
          label: m.fields[key],
          children: references[key] ? <NameOf path={references[key]} id={detail[key]} /> : cellValue(detail, key),
        }))}
      />
      {cancellation && <Alert type="warning" message={`${m.cancelReason}：${cancellation.reason ?? m.missing}`} />}
    </>
  );
}
function VersionsTab({ detail }: { detail: Row }) {
  const versions = Array.isArray(detail.versions) ? (detail.versions as Row[]) : [];
  return (
    <Table<Row>
      size="small"
      rowKey={(item) => String(item.versionNo)}
      pagination={false}
      dataSource={versions}
      locale={{ emptyText: m.empty }}
      columns={['lastWorkDate', 'effectiveDate', 'createdAt'].map((key) => ({
        key,
        title: m.fields[key],
        render: (_: unknown, item: Row) => cellValue(item, key),
      }))}
    />
  );
}

type BillEntry = 'submit' | 'withdraw' | 'cancel';
/**
 * 单据动作（提交 / 撤回 / 撤销）：按单据 revision 提交，与办理 / 申请共用员工恢复槽，任一入口结果未知都锁住同一员工；
 * 撤销超编由服务端 409 CONFIRMATION_REQUIRED 要求确认，确认后同一命令上下文带 confirmed 重提。
 */
function BillAction({ row, action, refresh }: { row: Row; action: BillEntry; refresh(): Promise<unknown> }) {
  const id = row.id!;
  const read = useBusinessRead(id);
  const target = {
    id: row.employeeId!,
    revision: row.revision,
    baseline: {},
    read: async () => ({ ...(await read()), id: row.employeeId! }),
  };
  const cmd = useRetireCommand(retireSlot, target, `${action}/${id}`, refresh);
  const [reason, setReason] = useState<string>();
  const run = async () => {
    try {
      const values = action === 'cancel' ? { reason: reason?.trim() ?? '' } : {};
      const done = await cmd.submit(values, action === 'cancel' ? ['reason'] : [], {
        path: `${slotKey(retirements, id)}/${action}`,
        body: (input, extra) => (action === 'cancel' ? { reason: input.reason, ...extra } : {}),
        accept: (raw, sent) => {
          const receipt = acceptRetirement(raw, { employeeId: row.employeeId!, sent, id });
          return { path: slotKey(`${apiRoot}/businesses`, id), id, revision: Number(receipt.revision) };
        },
      });
      if (!done) return;
      setReason(undefined);
      void message.success(m.success[action]);
    } catch {
      // 拒绝 / 冲突 / 结果未知由内核状态条显示
    }
  };
  const status = <CommandStatus submission={cmd.form} />;
  if (action === 'cancel')
    return (
      <Space direction="vertical">
        <Button danger disabled={cmd.disabled} onClick={() => setReason('')}>
          {m.entries.cancel}
        </Button>
        {status}
        <Modal
          open={reason !== undefined}
          title={m.entries.cancel}
          okText={m.confirm}
          cancelText={m.cancel}
          okButtonProps={{ disabled: cmd.disabled || !reason?.trim(), loading: cmd.form.busy }}
          onOk={() => void run()}
          onCancel={() => setReason(undefined)}
        >
          <Input.TextArea
            aria-label={m.cancelReason}
            placeholder={m.cancelReason}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {status}
        </Modal>
      </Space>
    );
  const title = action === 'withdraw' ? m.withdrawConfirm : m.submitConfirm;
  return <ConfirmAction cmd={cmd} label={m.entries[action]} title={title} run={run} />;
}
