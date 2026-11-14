// 右侧头部的操作：编辑、启用 / 停用、查看引用。启停经 F-123 内核，带本单 revision；
// 停用前先读引用（设计 §6.2）：有引用弹影响清单，确认后把看到的引用数作为 acknowledgedReferenceCount 提交。
import { App, Button, Modal, Space, Typography } from 'antd';
import { useState } from 'react';
import { rejectionMessage } from '../../foundation/client.js';
import { useApiClient } from '../../foundation/Session.js';
import { CommandStatus } from '../../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../../foundation/forms/ConflictCommands.js';
import type { CommandForm } from '../../foundation/forms/useCommandForm.js';
import { headLabels, headSnapshot, useHeadRead } from './HeadForm.js';
import { m } from './messages.js';
import {
  MATRICES,
  matrixPath,
  parseReceipt,
  type MatrixHead,
  type MatrixReferences,
  type MatrixStatus,
} from './model.js';
import { ReferenceTable, ReferencesDialog, readReferences } from './References.js';

type Kind = 'enable' | 'disable';
interface Pending {
  kind: Kind;
  references?: MatrixReferences;
}

type Saved = (receipt?: { id: string; status: MatrixStatus }) => void;

/** 启停命令：停用前读引用；明确拒绝时提示并释放命令，结果未知时保持锁定（DEC-067）。 */
function useStatusChange(head: MatrixHead, saved: Saved) {
  const api = useApiClient();
  const { message } = App.useApp();
  const writer = useConflictCommand(MATRICES, headSnapshot(head), useHeadRead(head), { action: 'status' });
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState(false);
  const ask = async (kind: Kind) => {
    if (kind === 'enable') return setPending({ kind });
    setBusy(true);
    try {
      setPending({ kind, references: await readReferences(api, head) });
    } catch (error) {
      void message.error(rejectionMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const run = async ({ kind, references }: Pending) => {
    setPending(undefined);
    let receipt: { id: string; status: MatrixStatus } | undefined;
    try {
      await writer.run({
        values: {},
        editableFields: [],
        send: async ({ command }) => {
          const body = {
            revision: command.revision,
            ...(references ? { acknowledgedReferenceCount: references.total } : {}),
          };
          const raw = await api.request<unknown>(matrixPath(head.id, kind), {
            method: 'POST',
            command: { ...command, body },
          });
          receipt = parseReceipt(raw, { id: head.id, revision: command.revision ?? 0 });
          return receipt;
        },
      });
      saved(receipt);
    } catch (error) {
      if (writer.form.peek()?.status === 'unknown') return;
      // 明确拒绝（版本冲突、引用已变化、状态不允许）：提示原因、释放命令并刷新列表，用户重新点击时重读引用、按新版本提交。
      void message.error(rejectionMessage(error));
      writer.form.clear();
      saved();
    }
  };
  return { form: writer.form as CommandForm, pending, setPending, busy, ask, run };
}

export function StatusActions(props: { head: MatrixHead; editable: boolean; edit(): void; saved: Saved }) {
  const { head, editable, edit, saved } = props;
  const { form, pending, setPending, busy, ask, run } = useStatusChange(head, saved);
  const [viewing, setViewing] = useState(false);
  const locked = form.locked || busy;
  // 本对象有未确认的编辑命令时（blocked）编辑入口仍可打开，去看那条命令的状态；启停自己未确认时编辑也锁住。
  const ownLocked = form.locked && !form.blocked;
  const impact = !!pending?.references?.total;
  return (
    <Space direction="vertical" size="small" className="matrix-actions">
      <Space wrap>
        {editable && (
          <Button type="primary" disabled={ownLocked || busy} onClick={edit}>
            {m.edit}
          </Button>
        )}
        {editable && head.status !== 'enabled' && (
          <Button disabled={locked} onClick={() => void ask('enable')}>
            {m.enable}
          </Button>
        )}
        {editable && head.status === 'enabled' && (
          <Button danger disabled={locked} loading={busy} onClick={() => void ask('disable')}>
            {m.disable}
          </Button>
        )}
        <Button onClick={() => setViewing(true)}>{m.references}</Button>
      </Space>
      <CommandStatus submission={form} labels={headLabels} />
      {pending && (
        <Modal
          open
          width={impact ? 880 : 420}
          title={pending.kind === 'enable' ? m.enable : m.disable}
          okText={m.confirm}
          cancelText={m.cancel}
          okButtonProps={{ danger: pending.kind === 'disable' }}
          onOk={() => void run(pending)}
          onCancel={() => setPending(undefined)}
        >
          {impact ? (
            <>
              <Typography.Paragraph>{m.impact}</Typography.Paragraph>
              <ReferenceTable references={pending.references!} />
            </>
          ) : (
            <Typography.Paragraph>
              {pending.kind === 'enable' ? m.confirmEnable(head.name) : m.confirmDisable(head.name)}
            </Typography.Paragraph>
          )}
        </Modal>
      )}
      {viewing && <ReferencesDialog head={head} close={() => setViewing(false)} />}
    </Space>
  );
}
