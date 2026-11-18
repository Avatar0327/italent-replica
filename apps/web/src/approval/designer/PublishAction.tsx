// F-326 S7b（主设计 §5.5 ④⑦）：设计器发布。经 F-123 内核（If-Match 流程版本 + 幂等键），与保存共用恢复槽、
// 动作记 publish：发布结果未知时保存也锁定。被拒后清掉原命令，重新发布换新命令 ID（DEC-067 不盲重试）。
// - 指定人员未选择（400 APPROVAL_SPECIFIED_APPROVER_REQUIRED）：按 details.slots 交给页面标出节点；
// - 待生效冲突（409 APPROVAL_PENDING_VARIABLE_CONFLICT）：弹窗逐个选“设计器值 / 变量页当前值”，带 pendingResolutions 重发。
import { useState } from 'react';
import { Alert, Button, Descriptions, Modal, Radio, Typography, type FormInstance } from 'antd';
import { rejectionMessage } from '../../foundation/client.js';
import { useApiClient } from '../../foundation/Session.js';
import { CommandStatus } from '../../foundation/forms/CommandStatus.js';
import { useConflictCommand } from '../../foundation/forms/ConflictCommands.js';
import type { CommandForm } from '../../foundation/forms/useCommandForm.js';
import type { Values } from '../../foundation/forms/values.js';
import { readProcess } from './api.js';
import { useDesignerPeople } from './FallbackHandlers.js';
import { base, validProcess, type ProcessView } from './model.js';
import { m } from './messages.js';
import { p } from './publish-messages.js';
import { s } from './source-messages.js';
import { DesignerError, useDesignerRequest } from './write.js';

export interface MissingSlot {
  nodeKey: string;
  nodeName: string;
  slot: string;
}
interface PendingConflict {
  variableId: string;
  code: string;
  name: string;
  revision: number;
  designerUserIds: string[];
  currentUserIds: string[];
}
type Choice = 'designer' | 'current';
interface Resolution {
  variableId: string;
  revision: number;
  choice: Choice;
}
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const entries = (value: unknown) =>
  (Array.isArray(value) ? value : []).filter((item): item is Values => !!item && typeof item === 'object');
const slotsOf = (details: Values): MissingSlot[] =>
  entries(details.slots).filter((item): item is Values & MissingSlot =>
    ['nodeKey', 'nodeName', 'slot'].every((k) => typeof item[k] === 'string'),
  );
const conflictsOf = (details: Values): PendingConflict[] =>
  entries(details.conflicts).filter(
    (item): item is Values & PendingConflict =>
      ['variableId', 'code', 'name'].every((k) => typeof item[k] === 'string') &&
      Number.isSafeInteger(item.revision) &&
      texts(item.designerUserIds) &&
      texts(item.currentUserIds),
  );
/** 回执绑定本次版本且最新版本已发布；形状不符由内核按结果未知锁定。 */
function acceptPublished(value: unknown, id: string, revision: number) {
  if (!validProcess(value, id) || value.revision <= revision || value.latestVersion.status !== 'published')
    throw new Error(m.invalidReceipt);
  return value;
}

export function usePublish(process: ProcessView, onMissing: (slots: MissingSlot[]) => void, onDone: () => void) {
  const api = useApiClient();
  const request = useDesignerRequest();
  const read = async () => {
    const latest = await readProcess(api, process.id);
    return { id: latest.id, revision: latest.revision, values: {} };
  };
  const snapshot = { id: process.id, revision: process.revision, values: {} };
  const command = useConflictCommand(base, snapshot, read, { action: 'publish' });
  const [error, setError] = useState<string>();
  const [conflicts, setConflicts] = useState<PendingConflict[]>();
  const run = async (resolutions?: Resolution[]) => {
    setError(undefined);
    onMissing([]);
    try {
      await command.run({
        values: {},
        editableFields: [],
        send: async ({ command: sending }) => {
          const body = resolutions ? { pendingResolutions: resolutions } : {};
          const path = `${base}/${encodeURIComponent(process.id)}/publish`;
          return acceptPublished(await request(path, 'POST', { ...sending, body }), process.id, sending.revision!);
        },
      });
      setConflicts(undefined);
      onDone();
    } catch (failure) {
      if (command.form.peek()?.status === 'unknown') return;
      command.form.clear();
      const details = failure instanceof DesignerError ? failure.details : {};
      const pending = details.reason === 'APPROVAL_PENDING_VARIABLE_CONFLICT' ? conflictsOf(details) : [];
      setConflicts(pending.length ? pending : undefined);
      if (pending.length) return;
      if (details.reason === 'APPROVAL_SPECIFIED_APPROVER_REQUIRED') onMissing(slotsOf(details));
      setError(rejectionMessage(failure));
    }
  };
  const form: CommandForm = command.form;
  return { form, run, error, conflicts, cancel: () => setConflicts(undefined) };
}
type Publish = ReturnType<typeof usePublish>;

export function PublishStatus({ publish }: { publish: Publish }) {
  return (
    <>
      <CommandStatus submission={publish.form} />
      {publish.error && <Alert type="error" showIcon message={publish.error} />}
      {publish.conflicts && (
        <PendingConflicts conflicts={publish.conflicts} publish={publish} busy={publish.form.busy} />
      )}
    </>
  );
}
/** 草稿有未保存的修改时不发布：发布的是服务端草稿，先保存才能发布页面上看到的内容。 */
export function PublishButton({
  publish,
  form,
  disabled,
}: {
  publish: Publish;
  form: FormInstance;
  disabled: boolean;
}) {
  const [dirty, setDirty] = useState(false);
  const start = () => {
    setDirty(form.isFieldsTouched());
    if (!form.isFieldsTouched()) void publish.run();
  };
  return (
    <>
      <Button
        aria-label={p.publish}
        loading={publish.form.busy}
        disabled={disabled || publish.form.locked || !!publish.form.blocked}
        onClick={start}
      >
        {p.publish}
      </Button>
      {dirty && <Alert type="warning" showIcon message={p.dirty} />}
    </>
  );
}

function PendingConflicts({
  conflicts,
  publish,
  busy,
}: {
  conflicts: PendingConflict[];
  publish: Publish;
  busy: boolean;
}) {
  const { known } = useDesignerPeople([
    ...new Set(conflicts.flatMap((c) => [...c.designerUserIds, ...c.currentUserIds])),
  ]);
  // 选择绑定变量版本：再次 409（选后变量又被改）时换成新条目，必须重新选
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const keyOf = (item: PendingConflict) => `${item.variableId}@${item.revision}`;
  const names = (ids: string[]) =>
    ids.length
      ? ids.map((id) => known?.choices.find((c) => c.value === id)?.label ?? s.personUnavailable).join('、')
      : s.unselected;
  const ready = conflicts.every((item) => choices[keyOf(item)]);
  const confirm = () =>
    void publish.run(
      conflicts.map((item) => ({
        variableId: item.variableId,
        revision: item.revision,
        choice: choices[keyOf(item)]!,
      })),
    );
  return (
    <Modal
      open
      title={p.conflictTitle}
      okText={p.confirm}
      cancelText={p.cancel}
      okButtonProps={{ disabled: !ready, loading: busy }}
      onOk={confirm}
      onCancel={publish.cancel}
    >
      <p>{p.conflictHint}</p>
      {conflicts.map((item) => (
        <section key={keyOf(item)} className="flow-pending-conflict">
          <Typography.Text strong>{item.name}</Typography.Text>{' '}
          <Typography.Text type="secondary">{item.code}</Typography.Text>
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'designer', label: p.designerValue, children: names(item.designerUserIds) },
              { key: 'current', label: p.currentValue, children: names(item.currentUserIds) },
            ]}
          />
          <Radio.Group
            value={choices[keyOf(item)]}
            onChange={(event) => setChoices({ ...choices, [keyOf(item)]: event.target.value as Choice })}
            options={[
              { value: 'designer', label: p.chooseDesigner },
              { value: 'current', label: p.chooseCurrent },
            ]}
          />
        </section>
      ))}
    </Modal>
  );
}
