import { Input, Select } from 'antd';
import { ENTRY_CANCEL_REASONS, ENTRY_REMARK_MAX } from '@italent/domain';
import { FormOverlay } from '../foundation/FormOverlay.js';
import { ApiError } from '../foundation/client.js';
import { useApiClient } from '../foundation/Session.js';
import type { Values } from '../foundation/forms/values.js';
import { cancelAvailable, collection, receipt, type Row } from './model.js';
import { refreshAfter, request, requireWrite, useEntryAccess, useEntryCommand } from './commands.js';
import { titleExtra } from './CompleteFields.js';
import { m } from './messages.js';

// 原因是本次取消的命令选项；已有取消说明只从 F-206 列表读回，不从提交值补造。
const cancelValues = (values: Values) => ({ ...values, reason: 'other', remark: values.cancelRemark ?? null });
export function CancelForm({ row, onClose, refresh }: { row: Row; onClose(): void; refresh(): Promise<void> }) {
  const api = useApiClient();
  const p = useEntryAccess();
  const baseline = cancelValues(row);
  const cmd = useEntryCommand(row, 'cancel', baseline, cancelValues);
  const allowed = p.edit && p.field('effectiveDate').editable && cancelAvailable(cmd.full);
  const access = { visible: true, editable: allowed };
  return (
    <FormOverlay
      open
      mode="modal"
      className="entry-postpone entry-cancel"
      title={m.cancelEntry}
      titleExtra={titleExtra}
      recordKey={row.id}
      submission={{ ...cmd.form, locked: cmd.form.locked || !allowed }}
      initialValues={baseline}
      onClose={onClose}
      groups={[
        { title: m.cancelHint, fields: [] },
        {
          title: '',
          fields: [
            {
              name: 'reason',
              label: m.fields.reason,
              control: (
                <Select options={Object.entries(ENTRY_CANCEL_REASONS).map(([value, label]) => ({ value, label }))} />
              ),
              access,
            },
            {
              name: 'remark',
              label: m.fields.remark,
              control: <Input.TextArea rows={4} showCount maxLength={ENTRY_REMARK_MAX} />,
              access,
            },
          ],
        },
      ]}
      onSubmit={async (values) => {
        requireWrite(allowed);
        await cmd.run(values, ['reason', 'remark'], async (command, link) => {
          const remark = String(command.body.remark ?? '').trim();
          const body = { reason: command.body.reason, ...(remark ? { remark } : {}) };
          let result: unknown;
          try {
            result = await request(api, `${collection}/${row.id}/cancel`, {
              method: 'POST',
              command: { ...command, body },
            });
          } catch (error) {
            // 重复取消的 CONFLICT 也必须先重读核对，不能作为普通拒绝解锁换命令重提（F-192b 附录 A(g)）。
            if (error instanceof ApiError && error.status === 409)
              throw new ApiError(409, 'REVISION_CONFLICT', 'refresh', error.message);
            throw error;
          }
          link(receipt(result, row, command, 'cancel'));
          await refreshAfter(refresh);
        });
      }}
    />
  );
}
