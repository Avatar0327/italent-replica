import { useState } from 'react';
import { missingTransferRequiredFields, requiredTransferFields } from '@italent/domain';
import { text, presetLabels, jobReferences } from './messages.js';
import type { Choice, FieldValue, TransferFormModel, TransferFormProps } from './types.js';

function valueText(value: FieldValue | undefined, choices?: readonly Choice[]): string {
  if (value == null || value === '') return text.empty;
  if (typeof value === 'boolean') return value ? text.yes : text.no;
  const choice = choices?.find((item) => item.id === value);
  if (choice) return choice.name;
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(value)) ? text.savedValue : String(value);
}
function choicesFor(model: TransferFormModel, code: string): readonly Choice[] | undefined {
  if (code === 'departmentId') return model.departments;
  if (code === 'employType')
    return [
      { id: 'internal', name: text.internal },
      { id: 'intern', name: text.intern },
      { id: 'external', name: text.external },
    ];
  if (code === 'directManagerId' || code === 'dottedManagerId') return model.references?.[code] ?? model.employees;
  return code in jobReferences ? (model.references?.[code] ?? []) : undefined;
}

export function TransferForm(props: TransferFormProps) {
  return (
    <form
      onSubmit={(event) => event.preventDefault()}
      aria-label={props.model.initiator === 'employee' ? text.personalTitle : text.subtitle}
    >
      <fieldset disabled={props.busy} className="transfer-basics">
        <legend>{props.model.initiator === 'employee' ? text.personalTitle : text.subtitle}</legend>
        <SelectionFields {...props} />
      </fieldset>
      {props.model.preview ? <EmploymentFields {...props} /> : <p>{text.readyHint}</p>}
      <TransferActions {...props} />
    </form>
  );
}

function SelectionFields({ model, onSelection }: TransferFormProps) {
  const reasons = model.catalog.reasons.filter(
    (reason) => reason.transferTypeCode === null || reason.transferTypeCode === model.transferTypeCode,
  );
  return (
    <div className="transfer-grid">
      {model.initiator === 'employee' ? (
        <p>
          {text.employee}：{model.employees.find((e) => e.id === model.employeeId)?.name}
        </p>
      ) : (
        <label>
          {text.employee}
          <select
            name="employeeId"
            value={model.employeeId}
            onChange={(event) => onSelection?.('employeeId', event.target.value)}
            required
          >
            <option value="">{text.employeePlaceholder}</option>
            {model.employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name} · {employee.code}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {text.date}
        <input
          name="effectiveDate"
          type="date"
          value={model.effectiveDate}
          onChange={(event) => onSelection?.('effectiveDate', event.target.value)}
          required
        />
      </label>
      {model.initiator !== 'employee' && (
        <label>
          {text.type}
          <select
            name="transferTypeCode"
            value={model.transferTypeCode}
            onChange={(event) => onSelection?.('transferTypeCode', event.target.value)}
            required
          >
            <option value="">{text.choose}</option>
            {model.catalog.types.map((type) => (
              <option key={type.code} value={type.code}>
                {type.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {text.reason}
        <select
          name="reasonCode"
          value={model.reasonCode}
          onChange={(event) => onSelection?.('reasonCode', event.target.value)}
        >
          <option value="">{text.choose}</option>
          {reasons.map((reason) => (
            <option key={reason.code} value={reason.code}>
              {reason.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function EmploymentFields(props: TransferFormProps) {
  const form = props.model.preview!.form;
  const required = new Set(requiredTransferFields(form));
  return (
    <fieldset disabled={props.busy}>
      <legend>{text.adjustment}</legend>
      <div className="transfer-grid transfer-values">
        {Object.entries(form.fieldModes).map(([field, mode]) => {
          if (mode === 'hidden' || mode === 'absent') return null;
          const [source, code] = field.split(':') as ['preset' | 'custom', string];
          const values = source === 'preset' ? props.model.preview!.fields : props.model.preview!.customFields;
          if (!Object.hasOwn(values, code)) return null;
          const custom = form.customFields.find((item) => item.id === code);
          const label = source === 'preset' ? presetLabels[code] : custom?.name;
          if (!label) return null;
          return (
            <FieldPair
              key={field}
              {...props}
              source={source}
              code={code}
              label={label}
              readonly={mode === 'readonly'}
              required={source === 'preset' && required.has(code)}
              valueType={custom?.valueType}
            />
          );
        })}
      </div>
    </fieldset>
  );
}

interface PairProps extends TransferFormProps {
  source: 'preset' | 'custom';
  code: string;
  label: string;
  readonly: boolean;
  required: boolean;
  valueType?: string;
}
function FieldPair(props: PairProps) {
  const { model, source, code, label, required } = props;
  const preview = model.preview!;
  const key = source === 'preset' ? 'fields' : 'customFields';
  const value = Object.hasOwn(model[key], code) ? model[key][code] : preview[key][code];
  const choices = source === 'preset' ? choicesFor(model, code) : undefined;
  return (
    <div className="transfer-field-pair">
      <div className="transfer-before">
        <span>
          {text.original}
          {label}
        </span>
        <output>{valueText(preview.before?.[key]?.[code], choices)}</output>
      </div>
      <label>
        {text.updated}
        {label}
        {required && text.required}
        <FieldControl {...props} value={value ?? null} choices={choices} />
      </label>
    </div>
  );
}

function FieldControl(props: PairProps & { value: FieldValue; choices?: readonly Choice[] }) {
  const { code, source, value, readonly, required, onField, valueType, choices } = props;
  const onChange = (next: FieldValue) => onField?.(source, code, next);
  const boolean = valueType === 'boolean' || code === 'isDepartmentHead' || code === 'isKeyPerson';
  if (!readonly && choices) return <ReferenceControl {...props} choices={choices} />;
  if (!readonly && boolean)
    return (
      <select
        name={code}
        required={required}
        value={value == null ? '' : String(value)}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value === 'true')}
      >
        <option value="">{text.choose}</option>
        <option value="true">{text.yes}</option>
        <option value="false">{text.no}</option>
      </select>
    );
  const numeric = valueType === 'integer' || valueType === 'decimal';
  return (
    <input
      name={code}
      required={required}
      readOnly={readonly}
      aria-readonly={readonly || undefined}
      type={valueType === 'date' ? 'date' : numeric ? 'number' : 'text'}
      step={valueType === 'decimal' ? 'any' : undefined}
      value={readonly && (choices || boolean) ? valueText(value, choices) : value == null ? '' : String(value)}
      onChange={(event) =>
        onChange(event.target.value === '' ? null : numeric ? Number(event.target.value) : event.target.value)
      }
    />
  );
}

function ReferenceControl(props: PairProps & { value: FieldValue; choices: readonly Choice[] }) {
  const { code, source, value, choices, onField, onReferenceQuery, label, required } = props;
  const [name, setName] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const query = async (next: number) => {
    if (!onReferenceQuery || loading) return;
    setLoading(true);
    try {
      await onReferenceQuery(code, name, next);
      setPage(next);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="transfer-reference">
      <select
        name={code}
        required={required}
        aria-label={`${text.updated}${label}`}
        value={value == null ? '' : String(value)}
        disabled={loading}
        onChange={(event) => onField?.(source, code, event.target.value || null)}
      >
        <option value="">{text.choose}</option>
        {value && !choices.some((item) => item.id === value) ? (
          <option value={String(value)}>{valueText(value)}</option>
        ) : null}
        {choices.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      {onReferenceQuery && code !== 'employType' && (
        <div className="transfer-reference-search">
          {code !== 'departmentId' && (
            <>
              <input
                aria-label={`${label}${text.referenceSearch}`}
                placeholder={text.referenceSearch}
                value={name}
                disabled={loading}
                onChange={(event) => setName(event.target.value)}
              />
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  void query(1);
                }}
              >
                {text.search}
              </button>
            </>
          )}
          <button
            type="button"
            disabled={loading || page === 1}
            onClick={() => {
              void query(page - 1);
            }}
          >
            {text.previous}
          </button>
          <button
            type="button"
            disabled={loading || choices.length < 100}
            onClick={() => {
              void query(page + 1);
            }}
          >
            {text.next}
          </button>
        </div>
      )}
    </div>
  );
}

function TransferActions({ model, onAction, busy, actionsDisabled }: TransferFormProps) {
  const preview = model.preview;
  const allowed = preview?.allowedActions;
  const direct = model.initiator !== 'employee' && preview?.allowDirectTransfer;
  const blocked =
    busy ||
    actionsDisabled ||
    !preview ||
    preview.requiredFieldsUnavailable ||
    missingTransferRequiredFields(preview.form, { ...preview.fields, ...model.fields }).length > 0;
  return (
    <div className="transfer-actions">
      {preview?.requiredFieldsUnavailable && <p role="alert">{text.requiredUnavailable}</p>}
      <button type="button" disabled={blocked || allowed?.application !== true} onClick={() => onAction?.('submit')}>
        {text.submit}
      </button>
      <button type="button" disabled={blocked || allowed?.application !== true} onClick={() => onAction?.('draft')}>
        {text.draft}
      </button>
      {direct && allowed?.directList === true ? (
        <button
          type="button"
          data-button-code="Employment.Tranfer"
          disabled={blocked}
          onClick={() => onAction?.('direct')}
        >
          {text.direct}
        </button>
      ) : null}
      {direct && allowed?.directRow === true ? (
        <button
          type="button"
          data-button-code="EmploymentRecord.LineOp.Transfer"
          disabled={blocked}
          onClick={() => onAction?.('direct')}
        >
          {text.directRow}
        </button>
      ) : null}
    </div>
  );
}
