import { Editable, type FormAccess } from './FormAccess.js';
import { text } from './messages.js';

export function NameField({
  access,
  value,
  onChange,
  maxLength = 200,
}: {
  access: FormAccess;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return (
    <Editable access={access} field="name">
      <label>
        {text.name}
        <input
          required={access.requiredFields.includes('name')}
          maxLength={maxLength}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    </Editable>
  );
}

export function OrderField({
  access,
  value,
  onChange,
  step,
  min,
}: {
  access: FormAccess;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
}) {
  return (
    <Editable access={access} field="displayOrder">
      <label>
        {text.displayOrder}
        <input
          required={access.requiredFields.includes('displayOrder')}
          type="number"
          step={step}
          min={min}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
    </Editable>
  );
}

export function EnabledField({
  access,
  value,
  onChange,
}: {
  access: FormAccess;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Editable access={access} field="enabled">
      <label>
        <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
        {text.enabled}
      </label>
    </Editable>
  );
}
