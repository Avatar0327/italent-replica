import { Alert, Button, Form, Select } from 'antd';
import type { ApprovalNode, ApproverSource } from '@italent/domain';
import { useFormLock } from '../../foundation/forms/FormLock.js';
import { nodeField } from './model.js';
import { DesignerPeople } from './FallbackHandlers.js';
import { changeSourceType, sourceInputError, sourceList, sourceOptions, sourceValueLabel } from './sources.js';
import { s } from './source-messages.js';

export function ApproverSources({
  node,
  approvalType,
  empty = false,
}: {
  node: ApprovalNode;
  approvalType: string;
  empty?: boolean;
}) {
  if (empty && node.emptyApproverPolicy !== 'specified') return null;
  const label = empty ? s.empty : s.main;
  const mainField = node.kind === 'countersign' ? 'approvers' : 'approver';
  const hint = node.kind === 'single' ? s.single : s.count;
  return (
    <section role="group" aria-label={label} className="flow-source-group">
      <Form.Item
        name={nodeField(node.key, empty ? 'emptyApproverSources' : mainField)}
        label={label}
        rules={[
          {
            validator: async (_, value) => {
              const issue = sourceInputError(value, node, approvalType, empty);
              if (issue) throw new Error(issue);
            },
          },
        ]}
      >
        <SourceValue node={node} approvalType={approvalType} empty={empty} />
      </Form.Item>
      <p className="flow-muted">{empty ? s.emptyHint : hint}</p>
    </section>
  );
}
function SourceValue({
  value,
  onChange,
  node,
  approvalType,
  empty,
}: {
  value?: ApproverSource | ApproverSource[];
  onChange?: (value: ApproverSource | ApproverSource[]) => void;
  node: ApprovalNode;
  approvalType: string;
  empty: boolean;
}) {
  const lock = useFormLock();
  const multiple = empty || node.kind === 'countersign';
  const blank = multiple ? [] : [{ type: 'specified' as const, value: '' }];
  const rows = sourceList(value) ?? blank;
  const options = sourceOptions(node, approvalType);
  const update = lock.guard((next: ApproverSource[]) => onChange?.(multiple ? next : next[0]!));
  const replace = (index: number, source: ApproverSource) => update(rows.map((row, i) => (i === index ? source : row)));
  return (
    <div>
      {rows.map((source, index) => (
        <SourceRow
          key={index}
          source={source}
          options={options}
          onChange={(next) => replace(index, next)}
          remove={multiple ? () => update(rows.filter((_, i) => i !== index)) : undefined}
        />
      ))}
      {multiple && (
        <Button
          disabled={lock.disabled || rows.length >= 200}
          onClick={() => update([...rows, { type: 'specified', value: '' }])}
        >
          {s.add}
        </Button>
      )}
      {value !== undefined && sourceInputError(value, node, approvalType, empty) && (
        <Alert type="warning" message={sourceInputError(value, node, approvalType, empty)} />
      )}
    </div>
  );
}

function SourceRow({
  source,
  options,
  onChange,
  remove,
}: {
  source: ApproverSource;
  options: ReturnType<typeof sourceOptions>;
  onChange(source: ApproverSource): void;
  remove?: () => void;
}) {
  const lock = useFormLock();
  const option = options.find((item) => item.value === source.type);
  const values =
    option?.children.map((item) => ({
      ...item,
      label: item.status === 'restricted' ? `${item.label} · ${s.restricted}` : item.label,
    })) ?? [];
  if (source.value && !values.some((item) => item.value === source.value))
    values.push({
      value: source.value,
      label: sourceValueLabel(source.value),
      disabled: true,
      status: 'restricted',
    });
  return (
    <div className="flow-source-row">
      <Select
        aria-label={s.type}
        value={source.type}
        options={options.map(({ value, label, disabled }) => ({ value, label, disabled }))}
        virtual={false}
        showSearch
        optionFilterProp="label"
        disabled={lock.disabled}
        placeholder={s.choose}
        onChange={lock.guard((type) => onChange(changeSourceType(source, type)))}
      />
      <div className="flow-source-value">
        {source.type === 'specified' ? (
          <DesignerPeople
            multiple={false}
            label={s.types.specified}
            value={source.value ? [source.value] : []}
            onChange={(ids) => onChange({ type: 'specified', value: ids[0] ?? '' })}
          />
        ) : (
          <Select
            aria-label={s.value}
            value={source.value || undefined}
            options={values}
            virtual={false}
            showSearch
            optionFilterProp="label"
            disabled={lock.disabled || !option || option.disabled}
            placeholder={s.choose}
            onChange={lock.guard((next) => onChange({ type: source.type, value: next }))}
          />
        )}
      </div>
      {remove && (
        <Button disabled={lock.disabled} aria-label={s.remove} onClick={remove}>
          {s.remove}
        </Button>
      )}
    </div>
  );
}
