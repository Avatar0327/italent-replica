import { Alert, Button, Descriptions, Modal, Popconfirm, Space, Table, Tag, message } from 'antd';
import { useState } from 'react';
import { NameOf } from '../contracts/references.js';
import { useRead } from '../part-time/useRead.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Values } from '../foundation/forms/values.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { refPaths } from '../part-time/references.js';
import { CancelForm, EditForm } from './EditForm.js';
import { useExitCommand } from './ExitCommands.js';
import { x } from './messages.js';
import {
  acceptHandoverSubmit,
  acceptResubmit,
  activationNotice,
  cellValue,
  columns,
  detailEntries,
  exits,
  handoverEntries,
  handoverRequests,
  object,
  parseHandover,
  type HandoverItem,
  type Row,
} from './exit-model.js';

const shown = [...columns.all, 'whereaboutsCode'];
const references: Record<string, string | undefined> = {
  departmentId: refPaths.departmentId,
  positionId: refPaths.positionId,
};
export const fieldValue = (row: Row, key: string) =>
  references[key] && typeof row[key] === 'string' ? (
    <NameOf path={references[key]} id={row[key]} />
  ) : (
    cellValue(row, key)
  );

/** 离职详情（B13）：动作按单据状态与权限快照推导；交接区只读展示，发起 / 重新提交按服务端状态。 */
export function ExitDetail({ id, onClose, refresh }: { id: string; onClose(): void; refresh(): Promise<unknown> }) {
  const detail = useRead<Row>(slotKey(exits, id));
  const permission = usePermissions(object).snapshot.objects[object];
  const [open, setOpen] = useState<'edit' | 'cancel'>();
  const row = detail.data;
  const reload = async () => {
    await Promise.all([detail.reload(), refresh()]);
  };
  const notice = row && activationNotice(row);
  return (
    <Modal open width={880} title={x.title} footer={null} onCancel={onClose}>
      {!row || detail.error ? (
        <PageState kind={detail.error ? 'error' : 'loading'} error={detail.error} retry={detail.refresh} />
      ) : (
        <>
          <Space wrap>
            {detailEntries(row, permission).map((entry) => (
              <Button key={entry} danger={entry === 'cancel'} onClick={() => setOpen(entry)}>
                {x.entries[entry]}
              </Button>
            ))}
          </Space>
          {notice && <Alert type="error" showIcon message={notice} />}
          <Descriptions size="small" column={2} bordered>
            {shown.map((key) => (
              <Descriptions.Item key={key} label={x.fields[key]}>
                {fieldValue(row, key)}
              </Descriptions.Item>
            ))}
          </Descriptions>
          <Handover row={row} refresh={reload} />
          <p className="exit-hint">{x.unverifiedSections}</p>
          {open === 'edit' && <EditForm id={id} onClose={() => setOpen(undefined)} refresh={reload} />}
          {open === 'cancel' && (
            <CancelForm id={id} revision={Number(row.revision)} onClose={() => setOpen(undefined)} refresh={reload} />
          )}
        </>
      )}
    </Modal>
  );
}

function Handover({ row, refresh }: { row: Row; refresh(): Promise<unknown> }) {
  const read = useRead<unknown>(`${slotKey(exits, row.id)}/handover`);
  const permission = usePermissions(object).snapshot.objects[object];
  let handover: ReturnType<typeof parseHandover> | undefined;
  let error = read.error;
  try {
    if (read.data !== undefined) handover = parseHandover(read.data);
  } catch (cause) {
    error = cause;
  }
  const reload = async () => {
    await Promise.all([read.reload(), refresh()]);
  };
  const request = handover?.request;
  const entries = handoverEntries(row, handover, permission);
  return (
    <section aria-label={x.handoverTitle}>
      <h3>
        {x.handoverTitle} {handover && <Tag>{x.handoverStatus[handover.status] ?? handover.status}</Tag>}
      </h3>
      {!!error && <PageState kind="error" error={error} retry={read.refresh} />}
      {request?.hint && <Alert type="info" message={request.hint} />}
      {entries.includes('submit') && (
        <HandoverButton kind="submit" target={{ id: row.id, revision: Number(row.revision) }} refresh={reload} />
      )}
      {request && entries.includes('resubmit') && <HandoverButton kind="resubmit" target={request} refresh={reload} />}
      {request && (
        <Table<HandoverItem>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={request.items}
          locale={{ emptyText: x.noHandoverItems }}
          columns={(['title', 'category', 'done'] as const).map((key) => ({
            key,
            title: x.handoverItems[key],
            render: (_: unknown, item: HandoverItem) =>
              key === 'done' ? (item.done ? x.itemDone : x.itemPending) : (item[key] ?? x.missing),
          }))}
        />
      )}
    </section>
  );
}

/**
 * 发起（详情 submit / 行内 submit-from-list）与重新提交交接：空请求体，If-Match 分别为离职单与交接单 revision；
 * 结果未知时按钮锁定。
 */
export function HandoverButton(props: {
  kind: 'submit' | 'submit-from-list' | 'resubmit';
  target: { id: string; revision: number };
  refresh(): Promise<unknown>;
}) {
  const { kind, target } = props;
  const resubmit = kind === 'resubmit';
  const label = resubmit ? x.entries.resubmit : x.entries.handover;
  const [baseline] = useState<Values>({});
  const resource = resubmit ? handoverRequests : exits;
  const cmd = useExitCommand(resource, { ...target, baseline }, resubmit ? 'resubmit' : 'handover', props.refresh);
  const accept = resubmit ? acceptResubmit : acceptHandoverSubmit;
  const run = async () => {
    try {
      const done = await cmd.submit({}, [], {
        path: resubmit
          ? `${slotKey(handoverRequests, target.id)}/resubmit`
          : `${slotKey(exits, target.id)}/handover/${kind}`,
        method: 'POST',
        body: () => ({}),
        accept: (raw, sent) => void accept(raw, { id: target.id, sent: Number(sent) }),
        confirmable: false,
      });
      if (done) void message.success(x.handoverSubmitted);
    } catch {
      // 拒绝 / 冲突 / 结果未知由内核状态条显示
    }
  };
  return (
    <Space direction="vertical">
      <Popconfirm
        title={label}
        okText={x.confirm}
        cancelText={x.cancel}
        disabled={cmd.disabled}
        onConfirm={() => void run()}
      >
        <Button loading={cmd.form.busy} disabled={cmd.disabled}>
          {label}
        </Button>
      </Popconfirm>
      <CommandStatus submission={cmd.form} />
    </Space>
  );
}
