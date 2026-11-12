import {
  CUSTOM_FIELD_NAME_MAX,
  CUSTOM_FIELD_VALUE_TYPES,
  CUSTOM_FIELD_WRITABLE_OBJECT_TYPES,
  type CustomFieldObjectType,
} from '@italent/domain';
import { Button, Input, Select, Switch } from 'antd';
import { useEffect, useRef } from 'react';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { useApiClient } from '../foundation/Session.js';
import { useConflictCommand, type Sending } from '../foundation/forms/ConflictCommands.js';
import { listPath, parseRows, PATH, receipt, type actions, type Definition } from './model.js';
import { m } from './messages.js';

type Props = {
  objectType: CustomFieldObjectType;
  row?: Definition;
  access: ReturnType<typeof actions>;
  saved(): void;
  close(): void;
};
export function DefinitionForm({ objectType, row, access, saved, close }: Props) {
  const api = useApiClient();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const writer = useConflictCommand(
    PATH,
    row ? { id: row.id, revision: row.revision, values: { inherit: row.inherit } } : { revision: 0, values: {} },
    row
      ? async () => {
          const latest = parseRows(await api.request(listPath(objectType))).find((item) => item.id === row.id);
          if (!latest) throw new Error(m.gone);
          return { id: latest.id, revision: latest.revision, values: { inherit: latest.inherit } };
        }
      : undefined,
  );
  const fields = fieldsFor(row, access);
  const send = async ({ command }: Sending) => {
    const body = row ? command.body : { ...command.body, name: String(command.body.name).trim() };
    const response = await api.request(row ? `${PATH}/${row.id}/inheritance` : PATH, {
      method: row ? 'PUT' : 'POST',
      command: { ...command, body },
    });
    return receipt(response, command.revision ?? 0, row?.id);
  };
  return (
    <FormOverlay
      open
      recordKey={row?.id ?? PATH}
      title={row ? m.edit : `${m.create}${m.title}`}
      submission={writer.form}
      initialValues={row ? { inherit: row.inherit } : { objectType, valueType: 'text' }}
      groups={[{ title: m.basic, fields }]}
      onClose={() => {
        if (writer.stale) saved();
        close();
      }}
      footerExtra={
        writer.form.status === 'unknown' && (
          <Button
            onClick={() => {
              void writer
                .replay(send)
                .then(() => {
                  if (alive.current) {
                    saved();
                    close();
                  }
                })
                .catch(() => undefined);
            }}
          >
            {m.retry}
          </Button>
        )
      }
      onSubmit={async (values) => {
        if (row && values.inherit === writer.full.inherit) return;
        await writer.run({
          values,
          editableFields: fields.filter((field) => field.access.editable).map((field) => field.name),
          send,
        });
        if (alive.current) saved();
      }}
    />
  );
}

function fieldsFor(row: Definition | undefined, access: ReturnType<typeof actions>): FormField[] {
  const required = [{ required: true, message: m.required }];
  return row
    ? [
        {
          name: 'inherit',
          label: m.inherit,
          control: <Switch />,
          access: { visible: true, editable: access.inherit },
        },
      ]
    : [
        {
          name: 'name',
          label: m.name,
          control: <Input maxLength={CUSTOM_FIELD_NAME_MAX} />,
          access: { visible: true, editable: access.editable('name') },
          rules: [{ required: true, whitespace: true, message: m.required }],
        },
        {
          name: 'valueType',
          label: m.valueType,
          control: <Select options={CUSTOM_FIELD_VALUE_TYPES.map((value) => ({ value, label: m.types[value] }))} />,
          access: { visible: true, editable: access.editable('valueType') },
          rules: required,
        },
        {
          name: 'objectType',
          label: m.objectType,
          control: (
            <Select options={CUSTOM_FIELD_WRITABLE_OBJECT_TYPES.map((value) => ({ value, label: m.objects[value] }))} />
          ),
          access: { visible: true, editable: access.editable('objectType') },
          rules: required,
        },
      ];
}
