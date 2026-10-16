import { Input } from 'antd';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { forAction } from '../foundation/forms/action.js';
import { slotKey } from '../foundation/forms/slot.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { CreateEntry } from '../evaluation/CreateEntry.js';
import {
  INFO,
  infoPath,
  infoReceipt,
  projectInfo,
  infoText as m,
  type InfoField,
  type InfoKind,
  type InfoRow,
} from './info-model.js';
import { InfoSelect, PEOPLE, ORGS, POSITIONS } from './info-references.js';

export function InfoForm(props: { kind: InfoKind; row?: InfoRow; close(): void; saved(): void }) {
  const form = <InfoEditor {...props} />;
  return props.row ? (
    form
  ) : (
    <CreateEntry path={infoPath(props.kind)} title={INFO[props.kind].create} close={props.close}>
      {form}
    </CreateEntry>
  );
}
function InfoEditor({ kind, row, close, saved }: { kind: InfoKind; row?: InfoRow; close(): void; saved(): void }) {
  const spec = INFO[kind];
  const permission = usePermissions(spec.object);
  const api = useApiClient();
  const path = infoPath(kind);
  const command = forAction(useCommandForm(slotKey(path, row?.id)), { action: 'edit' });
  const operation = permission.snapshot.objects[spec.object]?.dataOperations[row ? 'update' : 'create'] === true;
  const fields = infoFields(kind, permission, operation);
  const editable = fields.filter((f) => f.access.visible && f.access.editable).map((f) => f.name);
  const incomplete = !row && spec.fields.some((f) => f.required && !editable.includes(f.name));
  const read = async (id: string) => {
    const latest = await api.request<InfoRow>(`${path}/${id}`);
    return { id: latest.id, revision: latest.revision!, values: projectInfo(kind, latest) };
  };
  const submission = {
    ...command,
    locked: command.locked || !operation || incomplete || (!!row && !Number.isSafeInteger(row.revision)),
    reload: row ? () => command.reread(() => read(row.id)) : undefined,
  };
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={row?.id ?? 'new'}
      title={row ? m.edit : spec.create}
      submission={submission}
      initialValues={projectInfo(kind, row)}
      groups={
        kind === 'work-shifts'
          ? [
              { title: m.basic, fields: fields.slice(0, 1) },
              { title: m.rotation, fields: fields.slice(1) },
            ]
          : [{ title: '', fields }]
      }
      onClose={close}
      onRefresh={submission.reload}
      onSubmit={async (values) => {
        const result = await command.submit({
          values,
          baseline: projectInfo(kind, row),
          editableFields: editable,
          revision: row?.revision ?? 0,
          businessId: row?.id,
          patchOnly: !!row,
          send: async (request) => {
            const raw = await api.request<unknown>(slotKey(path, row?.id), {
              method: row ? 'PATCH' : 'POST',
              command: request,
            });
            const receipt = infoReceipt(raw, request.revision, 'save', row?.id);
            // 保存回执到重读之间始终处于 submitting；重读失败归入结果待确认，不能先解锁。
            const latest = await read(receipt.id);
            if (
              latest.id !== receipt.id ||
              !Number.isSafeInteger(latest.revision) ||
              latest.revision < receipt.revision!
            )
              throw new Error(m.invalid);
            return receipt;
          },
        });
        if (result.status !== 'done') throw result.error ?? new Error(m.invalid);
        saved();
        command.clear();
        close();
      }}
    />
  );
}
function InfoControl({
  kind,
  field,
  ...props
}: {
  kind: InfoKind;
  field: InfoField;
  id?: string;
  value?: string | null;
  onChange?(value: string | null): void;
  disabled?: boolean;
}) {
  const control =
    field.type === 'person' ? (
      <InfoSelect source={PEOPLE} person {...props} />
    ) : field.type === 'org' || field.type === 'position' ? (
      <InfoSelect source={field.type === 'org' ? ORGS : POSITIONS} {...props} />
    ) : field.type === 'date' ? (
      <TenantDatePicker {...props} value={props.value ?? undefined} />
    ) : (
      <Input.TextArea
        {...props}
        value={props.value ?? ''}
        maxLength={2000}
        rows={3}
        onChange={(e) => props.onChange?.(e.target.value)}
      />
    );
  return (
    <div
      className={`info-control info-${kind} info-field-${field.name}`}
      role={field.type === 'date' ? 'group' : undefined}
      aria-label={field.type === 'date' ? field.label : undefined}
    >
      {control}
    </div>
  );
}

function infoFields(kind: InfoKind, permission: ReturnType<typeof usePermissions>, operation: boolean) {
  return INFO[kind].fields.map((field): FormField => ({
    name: field.name,
    label: field.label,
    control: <InfoControl kind={kind} field={field} />,
    access: { ...permission.field(field.name), editable: operation && permission.field(field.name).editable },
    rules: [
      ...(field.required ? [{ required: true, message: m.required }] : []),
      ...(field.name === 'endDate'
        ? [
            ({ getFieldValue }: { getFieldValue(name: string): unknown }) => ({
              validator: (_: unknown, value: string) =>
                value && value < String(getFieldValue('startDate') ?? '')
                  ? Promise.reject(new Error(m.dateOrder))
                  : Promise.resolve(),
            }),
          ]
        : []),
      ...(field.name === 'tuteeEmployeeId'
        ? [
            ({ getFieldValue }: { getFieldValue(name: string): unknown }) => ({
              validator: (_: unknown, value: string) =>
                value && value === getFieldValue('tutorEmployeeId')
                  ? Promise.reject(new Error(m.selfTutor))
                  : Promise.resolve(),
            }),
          ]
        : []),
    ],
  }));
}
