import { Select } from 'antd';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { useApiClient } from '../foundation/Session.js';
import { NameOf, refPaths } from '../contracts/references.js';
import type { Values } from '../foundation/forms/values.js';
import { collection, receipt, type Row } from './model.js';
import { initial, refreshAfter, request, requireWrite, useEntryAccess, useEntryCommand } from './commands.js';
import { placeholders, readOnly, required, titleExtra, TrialSelect } from './CompleteFields.js';
import { m } from './messages.js';

export function EditForm({
  row,
  data,
  onClose,
  refresh,
}: {
  row: Row;
  data: Values;
  onClose(): void;
  refresh(): Promise<void>;
}) {
  const api = useApiClient();
  const p = useEntryAccess();
  const cmd = useEntryCommand(row, 'edit', data);
  const allowed = p.edit && p.field('effectiveDate').editable;
  const fields = editFields(cmd.full, p, allowed);
  const editable = fields.filter((f) => f.access.editable).map((f) => f.name);
  return (
    <FormOverlay
      open
      mode="modal"
      className="entry-form"
      title={m.edit}
      titleExtra={titleExtra}
      recordKey={row.id}
      submission={cmd.form}
      initialValues={initial(data, editable)}
      onClose={onClose}
      groups={[
        { title: m.headcount, fields: placeholders(m.headcountFields) },
        { title: m.entryInfo, fields },
        { title: m.social, fields: placeholders(m.socialFields) },
      ]}
      onSubmit={async (values) => {
        requireWrite(allowed);
        await cmd.run(values, editable, async (command) => {
          const replaced =
            command.body.effectiveDate !== cmd.full.effectiveDate ||
            (command.body.employType !== undefined && command.body.employType !== cmd.full.employType);
          receipt(
            await request(api, `${collection}/${row.id}`, { method: 'PATCH', command }),
            row,
            command,
            replaced ? 'replace' : 'edit',
          );
          await refreshAfter(refresh);
        });
      }}
    />
  );
}

function editFields(full: Values, p: ReturnType<typeof useEntryAccess>, allowed: boolean): FormField[] {
  const field = (name: string, label: string, control: FormField['control']): FormField => ({
    name,
    label,
    control,
    rules: required,
    access: { visible: true, editable: allowed && (name !== 'employType' || p.field(name).editable) },
  });
  return [
    readOnly(m.person, String(full.name ?? '--')),
    readOnly(m.code, String(full.code ?? '--')),
    readOnly(
      m.department,
      <NameOf path={refPaths.departmentId} id={full.departmentId} asOf={String(full.effectiveDate)} />,
    ),
    readOnly(m.position, <NameOf path={refPaths.positionId} id={full.positionId} asOf={String(full.effectiveDate)} />),
    readOnly(m.organization),
    field('effectiveDate', m.plannedDate, <TenantDatePicker />),
    readOnly(m.entryKind, m.kind[full.kind as keyof typeof m.kind] ?? '--'),
    readOnly(m.employmentForm),
    {
      ...field(
        'employType',
        m.employType,
        <Select
          placeholder={m.choose}
          options={Object.entries(m.relation).map(([value, label]) => ({ value, label }))}
        />,
      ),
      display: m.relation[full.employType as keyof typeof m.relation] ?? '--',
    },
    readOnly(m.workplace, String(full.place ?? '--')),
    field('probation', m.fields.probation, <TrialSelect />),
    readOnly(m.profitCenter),
  ];
}
