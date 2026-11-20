import {
  RETIREMENT_AGE_MONTHS,
  RETIREMENT_AGE_YEARS,
  RETIREMENT_CONDITION_FIELDS,
  RETIREMENT_CONDITION_LABELS,
  RETIREMENT_CONDITION_VALUES_MAX,
  RETIREMENT_EMPLOY_TYPES,
  RETIREMENT_REQUIRED_CONDITION,
  STATUTORY_FUNCTION_LABELS,
  type RetirementConditionField,
  type RetirementRulePurpose,
} from '@italent/domain';
import { Input, InputNumber, Select, Switch } from 'antd';
import { RefSelect, refPaths } from '../../contracts/references.js';
import { useRead } from '../../contracts/useRead.js';
import { FormOverlay, type FormField } from '../../foundation/FormOverlay.js';
import { slotKey } from '../../foundation/forms/slot.js';
import { useApiClient } from '../../foundation/Session.js';
import { m as personnel } from '../../personnel/messages.js';
import { useRuleCommand } from './commands.js';
import { s } from './messages.js';
import {
  conditionPaths,
  formValues,
  functionsFor,
  ruleBody,
  rulesPath,
  saveReceipt,
  typeFor,
  type Rule,
} from './model.js';

const required = { required: true, message: s.required };
const numeric = ({ min, max }: { min: number; max: number }) => [
  { required: true, type: 'integer' as const, min, max, message: s.numberRange(min, max) },
];
const access = { visible: true, editable: true };
const field = (name: keyof typeof s.fields, control: FormField['control'], rules?: FormField['rules']): FormField => ({
  name,
  label: s.fields[name],
  control,
  rules,
  access,
});

type DictionaryField = keyof typeof conditionPaths;
const isDictionary = (key: RetirementConditionField): key is DictionaryField => Object.hasOwn(conditionPaths, key);
type Option = { value: string; label: string };
const fixedOptions = {
  gender: Object.entries(s.gender).map(([value, label]) => ({ value, label })),
  employType: RETIREMENT_EMPLOY_TYPES.map((value) => ({ value, label: personnel.employTypes[value]! })),
};

function ConditionSelect({
  field,
  id,
  value = [],
  onChange,
  disabled,
}: {
  field: RetirementConditionField;
  id?: string;
  value?: string[];
  onChange?(value: string[]): void;
  disabled?: boolean;
}) {
  const source = isDictionary(field) ? conditionPaths[field] : undefined;
  const read = useRead<{ items: Record<string, unknown>[] }>(source?.path ?? null);
  const options: Option[] = source
    ? (Array.isArray(read.data?.items) ? read.data.items : []).flatMap((item) => {
        const code = item[source.key];
        if (typeof code !== 'string' || typeof item.name !== 'string') return [];
        if (item.enabled === false && !value.includes(code)) return [];
        // 已停用的历史值只在仍被选中时出现，让管理员能清掉它。
        return [{ value: code, label: item.name }];
      })
    : (fixedOptions[field as keyof typeof fixedOptions] ?? []);
  const tags = field === 'nationality';
  const missing = tags ? [] : value.filter((code) => !options.some((option) => option.value === code));
  return (
    <Select
      id={id}
      value={value}
      onChange={onChange}
      disabled={disabled}
      mode={tags ? 'tags' : 'multiple'}
      maxCount={RETIREMENT_CONDITION_VALUES_MAX}
      options={[...options, ...missing.map((code) => ({ value: code, label: code }))]}
      loading={read.loading}
      status={read.error ? 'error' : undefined}
      notFoundContent={read.error ? s.optionsUnavailable : undefined}
      optionFilterProp="label"
      virtual={false}
    />
  );
}

function conditions(): FormField[] {
  return RETIREMENT_CONDITION_FIELDS.map((key) => ({
    name: key,
    label: RETIREMENT_CONDITION_LABELS[key],
    control: <ConditionSelect field={key} />,
    access,
    rules: [
      ...(key === RETIREMENT_REQUIRED_CONDITION ? [{ ...required, type: 'array' as const, min: 1 }] : []),
      { type: 'array', defaultField: { type: 'string', max: 100, whitespace: true } },
    ],
  }));
}

function ruleFields(purpose: RetirementRulePurpose, row?: Rule): FormField[] {
  const fixed = typeFor(purpose, row) === 'fixed_age';
  const values = formValues(purpose, row);
  return [
    field('name', <Input maxLength={100} />, [{ ...required, whitespace: true, message: s.nameRequired }]),
    field('priority', <InputNumber precision={0} />, numeric({ min: 0, max: 9999 })),
    field('orgIds', <RefSelect multiple path={refPaths.orgId} ariaLabel={s.fields.orgIds} />, [
      { ...required, type: 'array', min: 1 },
      { type: 'array', max: 50, message: s.optionLimit(50) },
    ]),
    field('includeSubordinates', <Switch aria-label={s.fields.includeSubordinates} />),
    {
      name: 'ruleType',
      label: s.ruleType,
      control: null,
      display: fixed ? s.fixed : s.builtin,
      access: { visible: true, editable: false },
    },
    ...(fixed
      ? [
          field('retirementAgeYears', <InputNumber precision={0} />, numeric(RETIREMENT_AGE_YEARS)),
          field('retirementAgeMonths', <InputNumber precision={0} />, numeric(RETIREMENT_AGE_MONTHS)),
        ]
      : functionsFor(purpose).map((name) => ({
          name,
          label: s.fields[name],
          control: null,
          display: STATUTORY_FUNCTION_LABELS[String(values[name])] ?? s.noValue,
          access: { visible: true, editable: false },
        }))),
    ...(row ? [] : [field('enabled', <Switch aria-label={s.fields.enabled} />)]),
  ];
}

export function RuleEditor({
  purpose,
  row,
  writable,
  close,
  reload,
}: {
  purpose: RetirementRulePurpose;
  row?: Rule;
  writable: boolean;
  close(): void;
  reload(): void;
}) {
  const api = useApiClient();
  const writer = useRuleCommand(purpose, row ? 'edit' : 'create', row);
  const path = row ? slotKey(rulesPath, row.id) : rulesPath;
  const values = formValues(purpose, row);
  const groups = [
    { title: s.rules, fields: ruleFields(purpose, row) },
    { title: s.scope, fields: conditions() },
  ];
  const editable = groups.flatMap((group) =>
    group.fields.filter((item) => item.access.editable).map((item) => item.name),
  );
  return (
    <FormOverlay
      open
      recordKey={path}
      title={row ? s.edit : s.add}
      submission={{ ...writer.form, locked: writer.form.locked || !writable }}
      initialValues={values}
      groups={groups}
      onClose={() => {
        if (writer.stale) reload();
        close();
      }}
      onSubmit={async (draft) => {
        if (!writable) return;
        await writer.run({
          values: draft,
          editableFields: editable,
          send: async ({ edited, command }) => {
            const body = ruleBody(purpose, typeFor(purpose, row), { ...writer.full, ...edited });
            const raw = await api.request<unknown>(path, {
              method: row ? 'PUT' : 'POST',
              command: { ...command, body },
            });
            return saveReceipt(raw, purpose, command.revision, { id: row?.id });
          },
        });
        reload();
      }}
    />
  );
}
