import { Input } from 'antd';
import { ENTRY_REMARK_MAX } from '@italent/domain';
import { FormOverlay } from '../foundation/FormOverlay.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { useApiClient } from '../foundation/Session.js';
import { collection, receipt, type Row } from './model.js';
import { refreshAfter, request, requireWrite, useEntryAccess, useEntryCommand } from './commands.js';
import { required, titleExtra } from './CompleteFields.js';
import { m } from './messages.js';

export function PostponeForm({ row, onClose, refresh }: { row: Row; onClose(): void; refresh(): Promise<void> }) {
  const api = useApiClient();
  const p = useEntryAccess();
  const cmd = useEntryCommand(row, 'postpone');
  const allowed = p.edit && p.field('effectiveDate').editable;
  const access = { visible: true, editable: allowed };
  return (
    <FormOverlay
      open
      mode="modal"
      title={m.postpone}
      titleExtra={titleExtra}
      recordKey={row.id}
      submission={cmd.form}
      initialValues={{}}
      onClose={onClose}
      groups={[
        {
          title: '',
          fields: [
            {
              name: 'effectiveDate',
              label: m.fields.effectiveDate,
              control: <TenantDatePicker />,
              rules: required,
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
        await cmd.run(values, ['effectiveDate', 'remark'], async (command) => {
          const remark = String(command.body.remark ?? '').trim();
          const body = { effectiveDate: command.body.effectiveDate, ...(remark ? { remark } : {}) };
          receipt(
            await request(api, `${collection}/${row.id}/postpone`, { method: 'POST', command: { ...command, body } }),
            row,
            command,
            'postpone',
          );
          await refreshAfter(refresh);
        });
      }}
    />
  );
}
