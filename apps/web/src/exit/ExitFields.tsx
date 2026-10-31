import { Form, Input, Radio, Select } from 'antd';
import type { ReactNode } from 'react';
import { useRead } from '../part-time/useRead.js';
import { LockedField } from '../foundation/forms/FormLock.js';
import { fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { x } from './messages.js';
import { blacklistReasons } from './exit-model.js';
import { dictionaryPath, parseEntries, type Kind } from './model.js';

type Access = { editable: readonly string[]; permission: ObjectPermission | undefined };
type FieldProps = Access & { name: string; required?: boolean; extra?: string; children: ReactNode };

/** 字段可见性 / 可编辑性以字段权限为准（editableFields）：不可见不渲染，不可编辑只读显示。 */
function ExitField({ name, editable, permission, required, extra, children }: FieldProps) {
  if (!fieldAccess(permission, name).visible) return null;
  const label = x.fields[name]!;
  return (
    <Form.Item
      name={name}
      label={label}
      extra={extra}
      rules={required ? [{ required: true, message: x.required(label) }] : []}
    >
      <LockedField disabled={!editable.includes(name)}>{children}</LockedField>
    </Form.Item>
  );
}

type DictProps = { kind: Kind; label: string; value?: string | null; onChange?(value: string | null): void };
/** 离职类型 / 原因 / 去向：只列启用项（DM-R1）；已存的停用项按编码保留显示。 */
function DictSelect({ kind, label, ...props }: DictProps & { disabled?: boolean }) {
  const read = useRead<unknown>(`${dictionaryPath(kind)}?enabled=true`);
  let options: { value: string; label: string }[] = [];
  try {
    if (read.data !== undefined) options = parseEntries(read.data).map((row) => ({ value: row.code, label: row.name }));
  } catch {
    options = [];
  }
  return (
    <Select
      {...props}
      allowClear
      aria-label={label}
      loading={read.loading}
      options={options}
      onChange={(value) => props.onChange?.(value ?? null)}
    />
  );
}

const yesNo = [true, false].map((value) => ({ value, label: value ? x.yes : x.no }));
function YesNo(props: { value?: boolean; onChange?(value: boolean): void; disabled?: boolean }) {
  return (
    <Radio.Group
      {...props}
      aria-label={x.fields.addToBlacklist}
      onChange={(event) => props.onChange?.(event.target.value as boolean)}
      options={yesNo}
    />
  );
}

const dictionaries = Object.entries({ exitTypeCode: 'types', reasonCode: 'reasons', whereaboutsCode: 'whereabouts' });
/**
 * 新建与编辑共用：最后工作日、三个字典项、加入黑名单（默认否；选“是”才出现加黑三项）。
 * blackRequired：加黑原因是否必填；编辑时加黑组原样保留（blackGroupKept）则不要求重填。
 */
export function ExitFields({
  black,
  blackRequired = black,
  ...props
}: Access & { black: boolean; blackRequired?: boolean }) {
  return (
    <>
      <ExitField name="lastWorkDate" {...props} required>
        <TenantDatePicker />
      </ExitField>
      {dictionaries.map(([name, kind]) => (
        <ExitField key={name} name={name} {...props}>
          <DictSelect kind={kind as Kind} label={x.fields[name]!} />
        </ExitField>
      ))}
      <ExitField name="addToBlacklist" {...props}>
        <YesNo />
      </ExitField>
      {black && (
        <>
          <ExitField name="blacklistExpiryDate" {...props} extra={x.permanent}>
            <TenantDatePicker />
          </ExitField>
          <ExitField name="blacklistReason" {...props} required={blackRequired}>
            <Select aria-label={x.fields.blacklistReason} options={blacklistReasons} />
          </ExitField>
          <ExitField name="blacklistNote" {...props}>
            <Input.TextArea aria-label={x.fields.blacklistNote} maxLength={500} rows={3} />
          </ExitField>
        </>
      )}
    </>
  );
}
