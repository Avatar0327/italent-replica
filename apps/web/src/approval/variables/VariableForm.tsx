// 新建 / 编辑变量弹窗（规格 30 §二、三 新建弹窗）。写命令经 F-123 内核 useConflictCommand：新建 If-Match 0，编辑只发改动字段。
// 公共变量去掉「流程」适用范围时先读引用、确认后带 acknowledgedReferenceCount（设计 §6.2）。
import { Checkbox, Form, Input, InputNumber, Radio, Select, Space } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  VARIABLE_DATA_TYPES,
  VARIABLE_TEXT_FIELDS,
  VARIABLE_USAGE_SCOPES,
  defaultValueViolation,
  textViolation,
  usageScopesViolation,
  variableCodeViolation,
  type VariableDataType,
} from '@italent/domain';
import type { Command } from '../../foundation/client.js';
import { FormOverlay, type FormField } from '../../foundation/FormOverlay.js';
import { useApiClient } from '../../foundation/Session.js';
import { useConflictCommand } from '../../foundation/forms/ConflictCommands.js';
import type { Values } from '../../foundation/forms/store.js';
import { changedFields } from '../../foundation/forms/values.js';
import { m, type ScopeKind } from './messages.js';
import {
  EDIT_FIELDS,
  VARIABLES_PATH,
  createBody,
  createdReceipt,
  defaultValueOf,
  editValues,
  isAllScopes,
  parseReceipt,
  parseReferences,
  parseRow,
  prefixOf,
  removesProcess,
  rowPath,
  type Person,
  type VariableRow,
} from './model.js';
import { PersonValue } from './people.js';
import type { useImpactConfirm } from './References.js';

type Api = ReturnType<typeof useApiClient>;
type Rule = NonNullable<FormField['rules']>[number];
const snapshotOf = (row: VariableRow) => ({ id: row.id, revision: row.revision, values: { ...row } });
const check = (violation: (value: unknown) => unknown, message: string): Rule => ({
  validator: async (_, value) => {
    if (violation(value)) throw new Error(message);
  },
});
const textRule = (rule: { max: number; multiline: boolean }) =>
  check((value) => typeof value === 'string' && textViolation(value, rule), m.textInvalid);

/** 默认值控件随数据类型切换；新建时换数据类型清空已填的默认值。时间按 ISO 文本录入（控件形态未验证）。 */
function DefaultValueInput(props: {
  dataType?: VariableDataType;
  people: readonly Person[];
  value?: unknown;
  onChange?: (value: unknown) => void;
  id?: string;
  disabled?: boolean;
}) {
  const form = Form.useFormInstance();
  const watched = Form.useWatch('dataType', form) as VariableDataType | undefined;
  const dataType = props.dataType ?? watched ?? 'string';
  const { value, onChange, id, disabled } = props;
  const previous = useRef(dataType);
  useEffect(() => {
    if (previous.current !== dataType) onChange?.(null);
    previous.current = dataType;
  }, [dataType, onChange]);
  const common = { id, disabled };
  const text = (placeholder?: string) => (
    <Input
      {...common}
      placeholder={placeholder}
      value={(value as string) ?? ''}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
  switch (dataType) {
    case 'integer':
      return <InputNumber {...common} precision={0} value={value as number} onChange={(next) => onChange?.(next)} />;
    case 'decimal':
      return text();
    case 'datetime':
      return text(m.datetimePlaceholder);
    case 'boolean':
      return (
        <Select
          {...common}
          allowClear
          value={value as boolean | undefined}
          onChange={(next) => onChange?.(next ?? null)}
          options={[
            { value: true, label: m.booleans.true },
            { value: false, label: m.booleans.false },
          ]}
        />
      );
    case 'person':
    case 'persons':
      return (
        <PersonValue
          {...common}
          multiple={dataType === 'persons'}
          people={props.people}
          value={value as string | string[] | null}
          onChange={(next) => onChange?.(next)}
        />
      );
    default:
      return (
        <Input.TextArea
          {...common}
          autoSize={{ minRows: 1, maxRows: 4 }}
          value={(value as string) ?? ''}
          onChange={(e) => onChange?.(e.target.value)}
        />
      );
  }
}

/**
 * 适用范围：全部 / 指定范围；指定范围下多选（全选 / 流程 / 业务规则 / 消息模板）。值始终是三项的子集，全部即全集。
 * 单选由值推出（不是全集就是「指定范围」），只记用户在全集时主动点了「指定范围」：409 重读回填部分范围时跟着变。
 */
function UsageScopesInput(props: { value?: string[]; onChange?: (value: string[]) => void; disabled?: boolean }) {
  const { value = [], onChange, disabled } = props;
  const [pickedSome, setPickedSome] = useState(false);
  const mode = pickedSome || !isAllScopes(value) ? 'some' : 'all';
  const all = [...VARIABLE_USAGE_SCOPES];
  return (
    <Space direction="vertical">
      <Radio.Group
        disabled={disabled}
        value={mode}
        onChange={(e) => {
          setPickedSome(e.target.value === 'some');
          if (e.target.value === 'all') onChange?.(all);
        }}
        options={[
          { value: 'all', label: m.usageAll },
          { value: 'some', label: m.usageSome },
        ]}
      />
      {mode === 'some' && (
        <Space>
          <Checkbox
            disabled={disabled}
            checked={isAllScopes(value)}
            indeterminate={value.length > 0 && !isAllScopes(value)}
            onChange={(e) => onChange?.(e.target.checked ? all : [])}
          >
            {m.selectAll}
          </Checkbox>
          <Checkbox.Group
            disabled={disabled}
            value={value}
            onChange={(next) => onChange?.(next as string[])}
            options={all.map((scope) => ({ value: scope, label: m.usage[scope]! }))}
          />
        </Space>
      )}
    </Space>
  );
}

function formFields(scope: ScopeKind, row: VariableRow | undefined): FormField[] {
  const field = (name: string, label: string, control: ReactNode, rules: FormField['rules'] = []): FormField => ({
    name,
    label,
    control,
    access: { visible: true, editable: true },
    rules,
  });
  const fixed = (name: string, label: string, display: string): FormField => ({
    name,
    label,
    control: null,
    display,
    access: { visible: true, editable: false },
  });
  const required = { required: true, message: m.required };
  const fixedType = row?.dataType;
  const defaultRule: Rule = ({ getFieldValue }) => ({
    validator: async (_, value) => {
      const dataType = (fixedType ?? getFieldValue('dataType')) as VariableDataType;
      if (defaultValueViolation(dataType, defaultValueOf(dataType, value))) throw new Error(m.defaultInvalid);
    },
  });
  const typeOptions = VARIABLE_DATA_TYPES.map((type) => ({ value: type, label: m.dataTypes[type] }));
  return [
    row
      ? fixed('code', m.code, row.code)
      : field('codeSuffix', m.code, <Input prefix={prefixOf(scope)} maxLength={64} />, [
          required,
          check((value) => variableCodeViolation(scope, String(value ?? '')), m.codeInvalid[scope]),
        ]),
    field('name', m.name, <Input maxLength={VARIABLE_TEXT_FIELDS.variableName.max} />, [
      { ...required, whitespace: true },
      textRule(VARIABLE_TEXT_FIELDS.variableName),
    ]),
    row
      ? fixed('dataType', m.dataType, m.dataTypes[row.dataType] ?? row.dataType)
      : field('dataType', m.dataType, <Select options={typeOptions} />, [required]),
    field('defaultValue', m.defaultValue, <DefaultValueInput dataType={fixedType} people={row?.people ?? []} />, [
      defaultRule,
    ]),
    ...(scope === 'public'
      ? [
          field('usageScopes', m.usageScopes, <UsageScopesInput />, [
            check((value) => usageScopesViolation((value as string[]) ?? []), m.usageRequired),
          ]),
        ]
      : []),
    ...(row
      ? []
      : [
          field(
            'enable',
            m.status,
            <Radio.Group
              options={[
                { value: 'draft', label: m.statuses.draft },
                { value: 'enabled', label: m.statuses.enabled },
              ]}
            />,
            [required],
          ),
        ]),
    ...(scope === 'public'
      ? [
          field(
            'description',
            m.description,
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              maxLength={VARIABLE_TEXT_FIELDS.variableDescription.max}
            />,
            [textRule(VARIABLE_TEXT_FIELDS.variableDescription)],
          ),
        ]
      : []),
  ];
}

async function send(api: Api, command: Command<Values>, row?: VariableRow, acknowledged?: number) {
  const body =
    acknowledged === undefined ? command.body : { ...command.body, acknowledgedReferenceCount: acknowledged };
  const raw = await api.request<unknown>(row ? rowPath(row.id) : VARIABLES_PATH, {
    method: row ? 'PATCH' : 'POST',
    command: { ...command, body },
  });
  return row
    ? parseReceipt(raw, { id: row.id, revision: (command.revision ?? 0) + 1 })
    : parseReceipt(raw, createdReceipt(command.body?.enable === true));
}

export function VariableForm(props: {
  scope: ScopeKind;
  app?: string;
  row?: VariableRow;
  impact: ReturnType<typeof useImpactConfirm>;
  close(): void;
  saved(): void;
}) {
  const { scope, app, row, impact, close, saved } = props;
  const api = useApiClient();
  // 影响确认被取消时保留弹窗与已填内容，不当作保存完成关闭
  const keepOpen = useRef(false);
  const read = row ? async () => snapshotOf(parseRow(await api.request<unknown>(rowPath(row.id)))) : undefined;
  const writer = useConflictCommand(
    VARIABLES_PATH,
    row ? snapshotOf(row) : { revision: 0, values: {} },
    read,
    row ? { action: 'edit' } : {},
  );
  const editable = row?.scope === 'public' ? [...EDIT_FIELDS] : ['name', 'defaultValue'];
  const submitEdit = async (current: VariableRow, values: Values) => {
    const next = editValues(current, values);
    if (!changedFields(next, writer.full, editable).length) return;
    // 409 重读后按读回的最新全量判断：他人可能已加入「流程」并被流程引用，打开时的行已过时
    const latest = { ...current, ...(writer.full as Partial<VariableRow>) };
    let acknowledged: number | undefined;
    if (current.scope === 'public' && removesProcess(latest.usageScopes, next.usageScopes)) {
      const refs = parseReferences(await api.request<unknown>(rowPath(current.id, 'references')));
      const ok = await impact.ask({
        title: m.impactTitle(m.edit),
        warning: m.scopeImpactWarning,
        plain: m.confirmDisable(scope, latest.name).replace(m.disable, m.edit),
        items: refs.items,
      });
      if (!ok) {
        keepOpen.current = true;
        return;
      }
      acknowledged = refs.total;
    }
    await writer.run({
      values: next,
      editableFields: editable,
      send: ({ command }) => send(api, command, current, acknowledged),
    });
    saved();
  };
  const initialValues = row
    ? { name: row.name, defaultValue: row.defaultValue, usageScopes: row.usageScopes, description: row.description }
    : { dataType: 'string', defaultValue: null, usageScopes: [...VARIABLE_USAGE_SCOPES], enable: 'draft' };
  return (
    <FormOverlay
      open
      mode="modal"
      recordKey={row ? rowPath(row.id) : `${VARIABLES_PATH}#${scope}:${app ?? ''}`}
      submission={writer.form}
      title={`${row ? m.edit : m.create}${m.kind[scope]}`}
      titleExtra={!row && scope === 'public' ? <span className="form-hint">{m.usageHint}</span> : undefined}
      initialValues={initialValues}
      groups={[{ title: m.basic, fields: formFields(scope, row) }]}
      onClose={() => {
        if (keepOpen.current) {
          keepOpen.current = false;
          return;
        }
        // 冲突或结果未知时关掉：刷新列表回查（DEC-067），结果未知的命令在槽上仍锁定。
        if (writer.stale) saved();
        close();
      }}
      onSubmit={async (values) => {
        if (row) return submitEdit(row, values);
        const body = createBody(scope, app, values);
        await writer.run({
          values: body,
          editableFields: Object.keys(body),
          send: ({ command }) => send(api, command),
        });
        saved();
      }}
    />
  );
}
