import { useEffect, useState } from 'react';
import type { ApprovalDetail, FieldDraft } from './types.js';
import {
  displayValue,
  allowFieldClear,
  editableLeaf,
  editableValue,
  fieldKey,
  fieldKind,
  fieldLeaves,
  fieldText,
  valueDraft,
  type FieldLeaf,
  type FieldKind,
} from './fields.js';

interface Props {
  readonly form: ApprovalDetail['form'];
  readonly draft: FieldDraft;
  readonly onDraft: (draft: FieldDraft) => void;
  readonly disabled?: boolean;
}

function inputValue(value: unknown, kind: FieldKind): string {
  if (kind === 'scalar') return JSON.stringify(value) ?? '';
  if (kind === 'uuidArray' && value === null) return '[]';
  if (value === null || value === undefined) return '';
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

function FieldControl({
  kind,
  label,
  value,
  disabled,
  error,
  change,
}: {
  readonly kind: FieldKind;
  readonly label: string;
  readonly value: string;
  readonly disabled?: boolean;
  readonly error: string;
  readonly change: (input: string) => void;
}) {
  if (kind === 'boolean')
    return (
      <select aria-label={label} value={value} disabled={disabled} onChange={(event) => change(event.target.value)}>
        <option value="">{fieldText.empty}</option>
        <option value="true">{fieldText.yes}</option>
        <option value="false">{fieldText.no}</option>
      </select>
    );
  return (
    <input
      aria-label={label}
      aria-invalid={error ? true : undefined}
      type={kind === 'date' ? 'date' : 'text'}
      value={value}
      disabled={disabled}
      onChange={(event) => change(event.target.value)}
    />
  );
}

function FieldEditor({
  leaf,
  draft,
  onDraft,
  disabled,
}: Pick<Props, 'draft' | 'onDraft' | 'disabled'> & { readonly leaf: FieldLeaf }) {
  const [error, setError] = useState('');
  const [invalidInput, setInvalidInput] = useState<string | null>(null);
  const key = fieldKey(leaf.path);
  const label = leaf.path.join('.');
  const kind = fieldKind(leaf.path, leaf.value);
  const value = draft[key]?.value ?? leaf.value;
  const current = Object.hasOwn(draft, key) ? draft[key]!.value : value;
  const edit = draft[key];
  useEffect(() => {
    if (!edit) {
      setError('');
      setInvalidInput(null);
    }
  }, [edit]);
  const update = (value: unknown) => onDraft({ ...draft, [key]: { path: leaf.path, value } });
  const change = (input: string) => {
    try {
      update(valueDraft(input, leaf.value, leaf.path));
      setError('');
      setInvalidInput(null);
    } catch (thrown) {
      update(undefined);
      setInvalidInput(input);
      setError(thrown instanceof Error ? thrown.message : fieldText.invalidValue);
    }
  };
  return (
    <>
      <FieldControl
        kind={kind}
        label={label}
        value={invalidInput ?? inputValue(current, kind)}
        disabled={disabled}
        error={error}
        change={change}
      />
      {allowFieldClear(leaf.path) && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setError('');
            setInvalidInput(null);
            update(null);
          }}
        >
          {fieldText.clear(label)}
        </button>
      )}
      {kind === 'scalar' && <small>{fieldText.scalarHint}</small>}
      {error && <span role="alert">{error}</span>}
    </>
  );
}

export function ApprovalFields({ form, draft, onDraft, disabled = false }: Props) {
  const current = fieldLeaves(form.values);
  const originals = new Map(fieldLeaves(form.originals ?? {}).map((leaf) => [fieldKey(leaf.path), leaf]));
  const currentKeys = new Set(current.map((leaf) => fieldKey(leaf.path)));
  const originalOnly = [...originals.values()].filter((leaf) => !currentKeys.has(fieldKey(leaf.path)));
  return (
    <section aria-label={fieldText.fields}>
      <h3>{fieldText.fields}</h3>
      <dl>
        {current.map((leaf) => {
          const key = fieldKey(leaf.path);
          const label = leaf.path.join('.');
          const original = originals.get(key);
          const editable =
            form.editMode !== 'none' &&
            editableLeaf(leaf.path, form.editableFields) &&
            editableValue(leaf.value, leaf.path);
          return (
            <div key={key}>
              <dt>{fieldText.labels[label] ?? label}</dt>
              <dd>
                {editable ? (
                  <FieldEditor leaf={leaf} draft={draft} onDraft={onDraft} disabled={disabled} />
                ) : (
                  displayValue(leaf.value)
                )}
                {original && <p>{`${fieldText.original}：${displayValue(original.value)}`}</p>}
              </dd>
            </div>
          );
        })}
        {originalOnly.map((leaf) => (
          <div key={fieldKey(leaf.path)}>
            <dt>{fieldText.labels[leaf.path.join('.')] ?? leaf.path.join('.')}</dt>
            <dd>{`${fieldText.original}：${displayValue(leaf.value)}`}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
