import { Button, Modal, Space } from 'antd';
import { useEffect, useState } from 'react';
import { useApiClient } from '../foundation/Session.js';
import { usePermissions } from '../foundation/Permissions.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { forAction } from '../foundation/forms/action.js';
import { slotKey } from '../foundation/forms/slot.js';
import { projectFields } from '../foundation/forms/values.js';
import { INFO, infoPath, infoReceipt, infoText as m, type InfoRow, type InfoKind } from './info-model.js';

type Handlers = Map<string, () => Promise<void>>;
/** 后端只有单条 DELETE：一次确认后逐条执行，每条使用自己的恢复槽和回执。 */
export function InfoDelete({
  kind,
  rows,
  close,
  saved,
}: {
  kind: InfoKind;
  rows: InfoRow[];
  close(): void;
  saved(): void;
}) {
  const [handlers] = useState<Handlers>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const runAll = async () => {
    setBusy(true);
    setAttempted(true);
    try {
      for (const run of [...handlers.values()]) await run();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={m.remove}
      onCancel={close}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      footer={
        <Space>
          <Button onClick={close} disabled={busy}>
            {m.cancel}
          </Button>
          {rows.length > 1 && rows.length <= 50 && (
            <Button type="primary" disabled={attempted} loading={busy} onClick={runAll}>
              {m.confirmAll}
            </Button>
          )}
        </Space>
      }
    >
      <p>{m.deleting}</p>
      {rows.length > 50 ? (
        <p>{m.limit}</p>
      ) : (
        rows.map((row) => (
          <DeleteItem key={row.id} kind={kind} row={row} saved={saved} handlers={handlers} batchBusy={busy} />
        ))
      )}
    </Modal>
  );
}
function DeleteItem({
  kind,
  row,
  saved,
  handlers,
  batchBusy,
}: {
  kind: InfoKind;
  row: InfoRow;
  saved(): void;
  handlers: Handlers;
  batchBusy: boolean;
}) {
  const api = useApiClient();
  const permission = usePermissions(INFO[kind].object);
  const path = slotKey(infoPath(kind), row.id);
  const command = forAction(useCommandForm(path), { action: 'delete' });
  const [done, setDone] = useState(false);
  const fields = INFO[kind].fields.filter((field) => permission.field(field.name).visible);
  const names = fields.map((field) => field.name);
  const baseline = projectFields(command.state?.baseline ?? row, names);
  const current = projectFields(command.state?.latest?.values ?? baseline, names);
  const allowed =
    permission.can('delete') && permission.snapshot.objects[INFO[kind].object]?.dataOperations.delete === true;
  const submission = {
    ...command,
    reload: () =>
      command.reread(async () => {
        const latest = await api.request<InfoRow>(path);
        return { id: latest.id, revision: latest.revision!, values: projectFields(latest, names) };
      }),
  };
  const remove = async () => {
    if (done || !allowed || command.locked || !Number.isSafeInteger(row.revision)) return;
    const result = await command.submit({
      // 删除不修改字段：以可见原值参与内核差异核对（包括只读字段），相同值的 patch 请求体仍是 {}。
      values: baseline,
      baseline,
      editableFields: names,
      patchOnly: true,
      revision: row.revision!,
      businessId: row.id,
      send: async (request) =>
        infoReceipt(
          await api.request(path, { method: 'DELETE', command: request }),
          request.revision,
          'delete',
          row.id,
        ),
    });
    if (result.status === 'done') {
      setDone(true);
      saved();
    }
  };
  useEffect(() => {
    handlers.set(row.id, remove);
    return () => {
      handlers.delete(row.id);
    };
  }, [handlers, row.id, remove]);
  return (
    <div className="info-delete-item">
      <Space>
        <span>
          {String(current.startDate ?? m.none)} · {String(current.endDate ?? m.none)}
        </span>
        <Button
          disabled={batchBusy || done || !allowed || command.locked || !Number.isSafeInteger(row.revision)}
          loading={command.busy}
          onClick={remove}
        >
          {done ? m.deleted : m.confirm}
        </Button>
      </Space>
      <CommandStatus submission={submission} labels={Object.fromEntries(fields.map((f) => [f.name, f.label]))} />
    </div>
  );
}
