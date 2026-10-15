// F-127b A15～A17：合同类型、续签规则、合同设置的编辑与规则删除，统一走 F-123 内核。
import { Button, Input, InputNumber, Popconfirm, Select, Space, Switch } from 'antd';
import { FormOverlay, type FormField } from '../foundation/FormOverlay.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useApiClient } from '../foundation/Session.js';
import { useFormLock } from '../foundation/forms/FormLock.js';
import { slotKey } from '../foundation/forms/slot.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { projectFields } from '../foundation/forms/values.js';
import { parseSavedReceipt, parseSettingsReceipt } from './forms.js';
import { m } from './messages.js';
import { configObjects, contractApi, value, type Config, type Row } from './model.js';
import { RecoveryStatus, recoveryGroups, useConfigCommand } from './recovery.js';
import { PeopleSelect, RefLabels, RefSelect, refPaths } from './references.js';

const paths = { types: contractApi.types, rules: contractApi.rules, settings: contractApi.settings };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const configFields: Record<Config, string[]> = {
  types: ['code', 'name', 'enabled'],
  rules: ['name', 'priority', 'enabled', 'orgIds', 'personIds', 'details'],
  settings: [
    'autoRenew',
    'autoTerminate',
    'postExitTypeIds',
    'indefiniteTypeIds',
    'accumulateRehire',
    'renewalTypeIds',
    'autoNumber',
    'uniqueFields',
  ],
};
const defaults: Record<Config, Row> = {
  types: { code: null, name: null, enabled: true },
  rules: { name: null, priority: 0, enabled: true, orgIds: [], personIds: [], details: [] },
  settings: {},
};

/** 新建 / 编辑：类型与规则 PUT 需完整请求体（configuration.ts），设置按差异提交。 */
export function ConfigForm({
  kind,
  row,
  tenantId,
  onClose,
  onSaved,
}: {
  kind: Config;
  row?: Row;
  tenantId?: string;
  onClose(): void;
  onSaved(): void;
}) {
  const api = useApiClient();
  const permission = usePermissions(configObjects[kind]);
  const rowId = typeof row?.id === 'string' ? row.id : undefined;
  const id = kind === 'settings' ? tenantId : rowId;
  // 设置每租户一份，槽是设置路径；类型 / 规则按行 ID，新建为集合路径。
  const resource = kind === 'settings' ? slotKey(paths.settings) : slotKey(paths[kind], id);
  const keys = configFields[kind];
  // 冲突恢复统一走 useConfigCommand：展示值、携带字段与 If-Match 都取同一份确认后的基线。
  const { form, baseline, submit } = useConfigCommand(resource, {
    kind,
    id,
    row,
    keys,
    fallback: defaults[kind],
    action: id ? 'edit' : undefined,
  });
  const fields = formKeys(kind, keys).map((name) =>
    configField(kind, name, lockIf(permission.field(name), name === 'code' && !!id), baseline[name]),
  );
  const editable = fields.filter((field) => field.access.visible && field.access.editable).map((field) => field.name);
  // 类型 PUT 需完整请求体：编码（编辑时只读）与启用（原站在行内启停）不在表单里改，按确认后的基线原样带上。
  const carried = kind === 'types' ? ['code', 'enabled'].filter((name) => !editable.includes(name)) : [];
  return (
    <FormOverlay
      open
      mode={kind === 'types' ? 'modal' : undefined}
      recordKey={resource}
      submission={form}
      title={configTitle(kind, !!row)}
      groups={recoveryGroups(configGroups(kind, fields), form, onSaved)}
      initialValues={baseline}
      onClose={onClose}
      onRefresh={onSaved}
      onSubmit={async (values) => {
        const result = await submit({
          values: { ...projectFields(baseline, carried), ...values },
          editableFields: [...editable, ...carried],
          patchOnly: kind === 'settings',
          send: async (command, sent) => {
            const method = kind === 'settings' || id ? 'PUT' : 'POST';
            const path = kind === 'settings' || !id ? paths[kind] : `${paths[kind]}/${encodeURIComponent(id)}`;
            const raw = await api.request<unknown>(path, { method, command });
            return kind === 'settings'
              ? parseSettingsReceipt(raw, { tenantId: id ?? '', revision: sent })
              : parseSavedReceipt(raw, { id, revision: sent });
          },
        });
        if (result.status !== 'done') throw result.error ?? new Error(kernel.unknown);
        form.clear();
        onSaved();
      }}
    />
  );
}

/** 差异区字段名：与列表、表单用同一套标签。 */
export const configLabels: Record<'types' | 'rules', Record<string, string>> = {
  types: { code: m.typeCode, name: m.typeName, enabled: m.fields.enabled! },
  rules: Object.fromEntries(
    configFields.rules.map((key) => [key, key === 'name' ? m.ruleName : (m.fields[key] ?? key)]),
  ),
};
const lockIf = (field: { visible: boolean; editable: boolean }, readonly: boolean) =>
  readonly ? { ...field, editable: false } : field;
const formKeys = (kind: Config, keys: string[]) => (kind === 'types' ? keys.filter((key) => key !== 'enabled') : keys);
/** 标题与分组按原站：类型为居中弹窗“新建 / 编辑”，规则新增为“添加规则”，分“规则信息 / 流程发起规则”。 */
function configTitle(kind: Config, editing: boolean) {
  if (kind === 'types') return editing ? m.edit : m.create;
  if (kind === 'rules' && !editing) return m.addRule;
  return `${m.edit}${m[kind]}`;
}
function configGroups(kind: Config, fields: FormField[]) {
  if (kind !== 'rules') return [{ title: m[kind], fields }];
  return [
    { title: m.ruleInfo, fields: fields.filter((field) => field.name !== 'details') },
    { title: m.flowRule, fields: fields.filter((field) => field.name === 'details') },
  ];
}

function configField(
  kind: Config,
  name: string,
  access: { visible: boolean; editable: boolean },
  current: unknown,
): FormField {
  const label =
    ({ name: kind === 'types' ? m.typeName : m.ruleName, code: m.typeCode } as Record<string, string>)[name] ??
    m.fields[name] ??
    name;
  const typeList = ['postExitTypeIds', 'indefiniteTypeIds', 'renewalTypeIds'].includes(name);
  const required = (check: (input: unknown) => boolean, text = m.required) => [
    {
      validator: async (_: unknown, input: unknown) => {
        if (!check(input)) throw new Error(text);
      },
    },
  ];
  const filled = (input: unknown) => typeof input === 'string' && input.trim().length > 0;
  const field: FormField = {
    name,
    label,
    access,
    control: <Input maxLength={name === 'code' ? 100 : 200} />,
    display: value(current, name),
  };
  if (name === 'code' || name === 'name') return { ...field, rules: required(filled) };
  if (['enabled', 'autoRenew', 'autoTerminate', 'autoNumber', 'accumulateRehire'].includes(name))
    return { ...field, control: <Toggle label={label} /> };
  if (name === 'priority')
    return {
      ...field,
      control: <InputNumber min={0} precision={0} />,
      rules: required((input) => Number.isInteger(input) && Number(input) >= 0),
    };
  if (name === 'orgIds') return { ...field, control: <RefSelect path={refPaths.orgId} multiple ariaLabel={label} /> };
  if (name === 'personIds') return { ...field, control: <PeopleSelect /> };
  if (typeList)
    return {
      ...field,
      control: <RefSelect path={refPaths.typeId} multiple ariaLabel={label} />,
      display: <RefLabels path={refPaths.typeId} ids={current} />,
    };
  if (name === 'uniqueFields')
    return {
      ...field,
      control: (
        <Select
          mode="multiple"
          aria-label={label}
          options={['number', 'employeeId', 'typeId', 'effectiveDate'].map((key) => ({
            value: key,
            label: m.fields[key],
          }))}
        />
      ),
      rules: required((input) => Array.isArray(input) && input.length >= 1 && input.length <= 4),
    };
  return { ...field, control: <RuleDetails />, rules: required(validDetails, m.detailsInvalid) };
}
function Toggle({
  value,
  onChange,
  disabled,
  label,
}: {
  value?: boolean;
  onChange?: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return <Switch aria-label={label} checked={!!value} disabled={disabled} onChange={(next) => onChange?.(next)} />;
}

type Detail = {
  typeId?: string | null;
  months?: number | null;
  initiatorId?: string | null;
  daysBefore?: number | null;
  skipTypeIds?: string[];
};
const between = (input: unknown, min: number, max: number) =>
  Number.isInteger(input) && Number(input) >= min && Number(input) <= max;
/** 与 ruleSchema 一致：1～100 条；发起人是用户账号 ID（与审批转交的目标人口径一致）。 */
export function validDetails(input: unknown) {
  return (
    Array.isArray(input) &&
    input.length >= 1 &&
    input.length <= 100 &&
    input.every(
      (detail: Detail) =>
        typeof detail.typeId === 'string' &&
        detail.typeId.length > 0 &&
        between(detail.months, 1, 1200) &&
        typeof detail.initiatorId === 'string' &&
        uuid.test(detail.initiatorId) &&
        between(detail.daysBefore, 0, 3660),
    )
  );
}
function RuleDetails({
  value = [],
  onChange,
  disabled,
}: {
  value?: Detail[];
  onChange?: (value: Detail[]) => void;
  disabled?: boolean;
}) {
  const lock = useFormLock(disabled);
  const change = lock.guard((index: number, patch: Detail) =>
    onChange?.(value.map((detail, i) => (i === index ? { ...detail, ...patch } : detail))),
  );
  return (
    <Space direction="vertical" className="rule-details">
      {value.map((detail, index) => (
        <section className="contract-card" key={index} aria-label={`${m.fields.details} ${index + 1}`}>
          <DetailInputs detail={detail} disabled={lock.disabled} change={(patch) => change(index, patch)} />
          <Button disabled={lock.disabled} onClick={lock.guard(() => onChange?.(value.filter((_, i) => i !== index)))}>
            {m.removeDetail}
          </Button>
        </section>
      ))}
      <Button
        disabled={lock.disabled || value.length >= 100}
        onClick={lock.guard(() => onChange?.([...value, { skipTypeIds: [], daysBefore: 30, months: 12 }]))}
      >
        {m.addDetail}
      </Button>
    </Space>
  );
}
function DetailInputs({
  detail,
  disabled,
  change,
}: {
  detail: Detail;
  disabled: boolean;
  change(patch: Detail): void;
}) {
  const number = (key: 'daysBefore' | 'months', min: number, max: number) => (
    <label>
      {m.fields[key]}
      <InputNumber
        aria-label={m.fields[key]}
        min={min}
        max={max}
        precision={0}
        value={detail[key]}
        disabled={disabled}
        onChange={(next) => change({ [key]: next })}
      />
    </label>
  );
  return (
    <>
      <label>
        {m.fields.typeId}
        <RefSelect
          path={refPaths.typeId}
          value={detail.typeId}
          disabled={disabled}
          ariaLabel={m.fields.typeId}
          onChange={(next) => change({ typeId: next as string | null })}
        />
      </label>
      {number('daysBefore', 0, 3660)}
      {number('months', 1, 1200)}
      <label>
        {m.fields.initiatorId}
        <Input
          aria-label={m.fields.initiatorId}
          placeholder={m.userIdHint}
          value={detail.initiatorId ?? ''}
          disabled={disabled}
          onChange={(event) => change({ initiatorId: event.target.value.trim() })}
        />
      </label>
      <label>
        {m.fields.skipTypeIds}
        <RefSelect
          path={refPaths.typeId}
          multiple
          value={detail.skipTypeIds ?? []}
          disabled={disabled}
          ariaLabel={m.fields.skipTypeIds}
          onChange={(next) => change({ skipTypeIds: next as string[] })}
        />
      </label>
    </>
  );
}

/**
 * 行内写命令（规则删除 / 类型启停）：带 revision 与命令 ID，回执按实际提交的版本核对；结果未知时保持锁定。
 * 删除也按规则业务字段比较：重读后展示他人改了什么，核对前不删除。
 */
export function RowCommand({ kind, row, onDone }: { kind: 'delete' | 'toggle'; row: Row; onDone(): void }) {
  const api = useApiClient();
  const id = String(row.id);
  const config = kind === 'delete' ? 'rules' : 'types';
  const path = `${paths[config]}/${encodeURIComponent(id)}`;
  const keys = configFields[config];
  const { form, baseline, submit } = useConfigCommand(slotKey(paths[config], id), {
    kind: config,
    id,
    row,
    keys,
    action: kind,
  });
  const run = async () => {
    const result = await submit({
      // 启停：类型 PUT 需完整请求体，只翻转启用；删除：按基线原样比较、不带请求字段（patchOnly 后为空）。
      values: kind === 'toggle' ? { ...baseline, enabled: !baseline.enabled } : baseline,
      editableFields: keys,
      patchOnly: kind === 'delete',
      send: async (command, sent) =>
        parseSavedReceipt(await api.request<unknown>(path, { method: kind === 'delete' ? 'DELETE' : 'PUT', command }), {
          id,
          revision: sent,
          deleted: kind === 'delete',
        }),
    });
    // 拒绝 / 冲突 / 未知由状态区按内核状态展示。
    if (result.status !== 'done') return;
    form.clear();
    onDone();
  };
  const toggleLabel = baseline.enabled ? m.disabled : m.enabled;
  const label = kind === 'delete' ? m.delete : toggleLabel;
  return (
    <Space direction="vertical">
      {/* 不用 loading：antd 加载图标的离场动画没有超时兜底，提交很快返回时可能停在离场态；
          提交中由 locked 禁用、状态区显示“提交中”。 */}
      <Popconfirm
        title={kind === 'delete' ? m.deleteConfirm : m.toggleConfirm(label)}
        okText={m.confirm}
        cancelText={m.cancel}
        onConfirm={() => void run()}
      >
        <Button type="link" danger={kind === 'delete'} disabled={form.locked}>
          {label}
        </Button>
      </Popconfirm>
      <RecoveryStatus form={form} labels={configLabels[config]} onRefresh={onDone} />
    </Space>
  );
}
