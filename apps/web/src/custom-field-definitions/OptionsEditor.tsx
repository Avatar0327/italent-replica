import { CUSTOM_FIELD_OPTION_LIMIT, type CustomFieldOption } from '@italent/domain';
import { Button, Input, Space, Switch } from 'antd';
import { useFormLock } from '../foundation/forms/FormLock.js';
import { m } from './messages.js';

export function OptionsEditor({
  value = [],
  onChange,
  existing = [],
  disabled,
}: {
  value?: readonly CustomFieldOption[];
  onChange?(value: readonly CustomFieldOption[]): void;
  existing?: readonly CustomFieldOption[];
  disabled?: boolean;
}) {
  const lock = useFormLock(disabled);
  const change = lock.guard(onChange);
  const update = (index: number, patch: Partial<CustomFieldOption>) =>
    change(value.map((option, i) => (i === index ? { ...option, ...patch } : option)));
  const move = (source: string, target: number) => {
    const from = value.findIndex((option) => option.value === source);
    if (from < 0 || from === target) return;
    const next = [...value];
    const [option] = next.splice(from, 1);
    next.splice(target, 0, option!);
    change(next);
  };
  return (
    <Space direction="vertical">
      {value.map((option, index) => (
        <div
          key={option.value}
          draggable={!lock.disabled}
          onDragStart={lock.guard((event) => event.dataTransfer.setData('text/plain', option.value))}
          onDragOver={lock.guard((event) => event.preventDefault())}
          onDrop={lock.guard((event) => {
            event.preventDefault();
            move(event.dataTransfer.getData('text/plain'), index);
          })}
        >
          <Space>
            <Input
              aria-label={m.optionName(index + 1)}
              value={option.label}
              disabled={lock.disabled}
              onChange={lock.guard((event) => update(index, { label: event.target.value }))}
            />
            <Switch
              aria-label={m.optionEnabled(index + 1)}
              checked={option.enabled}
              disabled={lock.disabled}
              checkedChildren={m.enabled}
              unCheckedChildren={m.disabled}
              onChange={lock.guard((enabled) => update(index, { enabled }))}
            />
            {!existing.some((old) => old.value === option.value) && (
              <Button disabled={lock.disabled} onClick={() => change(value.filter((_, i) => i !== index))}>
                {m.removeOption}
              </Button>
            )}
          </Space>
        </div>
      ))}
      <Button
        disabled={lock.disabled || value.length >= CUSTOM_FIELD_OPTION_LIMIT}
        onClick={() => change([...value, { value: crypto.randomUUID(), label: '', enabled: true }])}
      >
        {m.addOption}
      </Button>
      <span>{m.optionOrder}</span>
    </Space>
  );
}
