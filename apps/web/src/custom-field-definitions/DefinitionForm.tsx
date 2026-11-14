import {
  CUSTOM_FIELD_NAME_MAX,
  CUSTOM_FIELD_VALUE_TYPES,
  CUSTOM_FIELD_WRITABLE_OBJECT_TYPES,
  isCustomFieldOptions,
  type CustomFieldObjectType,
  type CustomFieldOption,
} from '@italent/domain';
import { Button, Input, Select, Switch } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { useApiClient } from '../foundation/Session.js';
import { useConflictCommand, type Sending } from '../foundation/forms/ConflictCommands.js';
import { listPath, mergeOptions, parseRows, PATH, receipt, type actions, type Definition } from './model.js';
import { m } from './messages.js';
import { OptionsEditor } from './OptionsEditor.js';
import { sameValue } from '../foundation/forms/values.js';
import type { CommandForm } from '../foundation/forms/useCommandForm.js';

type Props = {
  objectType: CustomFieldObjectType;
  row?: Definition;
  mode?: 'inheritance' | 'options';
  access: ReturnType<typeof actions>;
  saved(): void;
  close(): void;
};
export function DefinitionForm({ objectType, row, mode = 'inheritance', access, saved, close }: Props) {
  const api = useApiClient();
  const [valueType, setValueType] = useState(row?.valueType ?? 'text');
  const fieldName = mode === 'options' ? 'options' : 'inherit';
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const writer = useConflictCommand(
    PATH,
    row ? { id: row.id, revision: row.revision, values: { [fieldName]: row[fieldName] } } : { revision: 0, values: {} },
    row
      ? async () => {
          const latest = parseRows(await api.request(listPath(objectType))).find((item) => item.id === row.id);
          if (!latest) throw new Error(m.gone);
          return { id: latest.id, revision: latest.revision, values: { [fieldName]: latest[fieldName] } };
        }
      : undefined,
    { action: row ? mode : 'create' },
  );
  const submission = useMergedOptions(writer.form);
  // 编辑器的“已保存”集合跟随最新版本：重读后他人新存的选项同样不可移除。
  const stored = writer.full.options as readonly CustomFieldOption[] | undefined;
  const fields = fieldsFor(row, access, mode, valueType, setValueType, stored);
  const send = async ({ command }: Sending) => {
    const body = row ? command.body : { ...command.body, name: String(command.body.name).trim() };
    const response = await api.request(row ? `${PATH}/${row.id}/${mode}` : PATH, {
      method: row ? 'PUT' : 'POST',
      command: { ...command, body },
    });
    return receipt(response, command.revision ?? 0, row?.id);
  };
  return (
    <FormOverlay
      open
      recordKey={row?.id ?? PATH}
      title={row ? (mode === 'options' ? m.editOptions : m.edit) : `${m.create}${m.title}`}
      submission={submission}
      initialValues={row ? { [fieldName]: row[fieldName] } : { objectType, valueType: 'text' }}
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
        if (row && sameValue(values[fieldName], writer.full[fieldName])) return;
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

/**
 * 409 重读后把选项草稿按编码并入最新版本（mergeOptions），交给表单回填与差异表；内核状态本身不改。
 * 只认重读时算出的差异：差异、草稿、最新三者引用在“继续编辑”后不变，合并结果稳定、不覆盖继续输入的内容；
 * 再次提交时内核新状态不带差异，合并随之结束。结果未知、处理中的命令原样显示，不改其钉住的请求体。
 */
function useMergedOptions(form: CommandForm): CommandForm {
  const { state } = form;
  const pending = state?.status === 'unknown' || state?.status === 'submitting';
  const { values, latest, differences } = state ?? {};
  const merged = useMemo(() => {
    const diff = differences?.find((item) => item.field === 'options');
    if (pending || !values || !latest || !diff) return undefined;
    const options = mergeOptions(diff.before, values.options, latest.values.options);
    return {
      values: { ...values, options },
      differences: differences!.map((item) => (item === diff ? { ...item, mine: options } : item)),
    };
  }, [pending, values, latest, differences]);
  return merged && state ? { ...form, state: { ...state, ...merged } } : form;
}

function fieldsFor(
  row: Definition | undefined,
  access: ReturnType<typeof actions>,
  mode: string,
  valueType: string,
  setType: (value: NonNullable<Definition['valueType']>) => void,
  stored: readonly CustomFieldOption[] | undefined,
): FormField[] {
  const required = [{ required: true, message: m.required }];
  const options: FormField = {
    name: 'options',
    label: m.options,
    control: <OptionsEditor existing={stored} />,
    access: { visible: access.editable('options'), editable: access.editable('options') },
    rules: [
      {
        validator: (_, value) =>
          isCustomFieldOptions(value) ? Promise.resolve() : Promise.reject(new Error(m.invalidOptions)),
      },
    ],
  };
  if (row && mode === 'options') return [options];
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
          control: <TypeSelect setType={setType} allowSelect={access.editable('options')} />,
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
        ...(valueType === 'select' ? [options] : []),
      ];
}

function TypeSelect({
  value,
  onChange,
  setType,
  allowSelect,
  disabled,
  id,
}: {
  value?: NonNullable<Definition['valueType']>;
  onChange?(value: string): void;
  setType(value: NonNullable<Definition['valueType']>): void;
  allowSelect: boolean;
  disabled?: boolean;
  id?: string;
}) {
  useEffect(() => {
    setType(value ?? 'text');
  }, [value, setType]);
  return (
    <Select
      id={id}
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={CUSTOM_FIELD_VALUE_TYPES.filter((type) => type !== 'select' || allowSelect).map((type) => ({
        value: type,
        label: m.types[type],
      }))}
    />
  );
}
