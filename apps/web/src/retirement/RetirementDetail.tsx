import { Button, Descriptions, Drawer, Modal, Space, Table, Tabs, Tag, message } from 'antd';
import { useState } from 'react';
import { NameOf } from '../contracts/references.js';
import { exits } from '../exit/exit-model.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import type { Values } from '../foundation/forms/values.js';
import { slotKey } from '../foundation/forms/slot.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useBusinessRead } from '../intern/commands.js';
import { refPaths } from '../part-time/references.js';
import { useRead } from '../part-time/useRead.js';
import { StaffDetail } from '../personnel/StaffDetail.js';
import { ConfirmAction, useRetireCommand } from './commands.js';
import { useRetireDraft } from './draft.js';
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
  type Extra,
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
                { key: 'handover', label: m.tabs.handover, children: <HandoverTab id={row.id!} /> },
                { key: 'versions', label: m.tabs.versions, children: <VersionsTab detail={detail} /> },
              ]}
            />
          )}
        </>
      )}
    </Drawer>
  );
}

/**
 * 交接页签（F-351）：读 GET /exits/:id/handover（后端已受理退休单），只显示交接状态；
 * 退休不在本页发起交接（发起入口仍在离职交接，B4 另做），所以不画提交 / 重提按钮。
 */
function HandoverTab({ id }: { id: string }) {
  const read = useRead<{ status?: unknown }>(`${slotKey(exits, id)}/handover`);
  const status = typeof read.data?.status === 'string' ? read.data.status : undefined;
  return (
    <section aria-label={m.tabs.handover}>
      {read.error ? <PageState kind="error" error={read.error} retry={read.refresh} /> : null}
      {status && <Tag>{m.handoverStatus[status] ?? status}</Tag>}
    </section>
  );
}
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

/**
 * 撤销不收原因（DEC-714），只带确认项（confirmed）；提交被要求确认在途调动时，令牌放 pendingTransferAck（EmploymentBusinessPatch，
 * 第 2 轮 P2-2）；撤回只发空体。
 */
function billBody(action: BillEntry, extra: Extra): Values {
  if (action === 'cancel') return { ...extra };
  return action === 'submit' && extra.ack ? { pendingTransferAck: extra.ack } : {};
}

type BillEntry = 'submit' | 'withdraw' | 'cancel';
type BillProps = { row: Row; action: BillEntry; refresh(): Promise<unknown> };
/**
 * 单据动作（提交 / 撤回 / 撤销）：按单据 revision 提交，与办理 / 申请共用员工恢复槽，任一入口结果未知都锁住同一员工；
 * 撤销超编由服务端 409 CONFIRMATION_REQUIRED 要求确认，确认后同一命令上下文带 confirmed 重提。
 */
function BillAction({ row, action, refresh }: BillProps) {
  const id = row.id!;
  const read = useBusinessRead(id);
  const target = {
    id: row.employeeId!,
    revision: row.revision,
    baseline: {},
    read: async () => ({ ...(await read()), id: row.employeeId! }),
  };
  const cmd = useRetireCommand(retireSlot, target, `${action}/${id}`, refresh);
  const drafts = useRetireDraft(row.employeeId!);
  const [confirming, setConfirming] = useState(false);
  const run = async () => {
    try {
      // 回读的单据状态交草稿入口决定本单引用的去留
      let readback: Values = {};
      const done = await cmd.submit({}, [], {
        path: `${slotKey(retirements, id)}/${action}`,
        body: (_input, extra) => billBody(action, extra),
        accept: (raw, sent) => {
          const receipt = acceptRetirement(raw, { employeeId: row.employeeId!, sent, id });
          const verify = (latest: Values) => {
            readback = latest;
          };
          return { path: slotKey(`${apiRoot}/businesses`, id), id, revision: Number(receipt.revision), verify };
        },
      });
      if (!done) return;
      // 同一单据已在详情处理并确认：提交 / 撤销后员工入口不再接续，撤回回到草稿则继续原单（第 4 轮 P2-R3-1）
      drafts.settled(id, action, readback);
      setConfirming(false);
      void message.success(m.success[action]);
    } catch {
      // 拒绝 / 冲突 / 结果未知由内核状态条显示
    }
  };
  const status = <CommandStatus submission={cmd.form} />;
  if (action === 'cancel')
    return (
      <Space direction="vertical">
        <Button danger disabled={cmd.disabled} onClick={() => setConfirming(true)}>
          {m.entries.cancel}
        </Button>
        {status}
        <Modal
          open={confirming}
          title={m.entries.cancel}
          okText={m.confirm}
          cancelText={m.cancel}
          okButtonProps={{ disabled: cmd.disabled, loading: cmd.form.busy }}
          onOk={() => void run()}
          onCancel={() => setConfirming(false)}
        >
          {m.cancelWarning}
          {status}
        </Modal>
      </Space>
    );
  const title = action === 'withdraw' ? m.withdrawConfirm : m.submitConfirm;
  return <ConfirmAction cmd={cmd} label={m.entries[action]} title={title} run={run} />;
}
