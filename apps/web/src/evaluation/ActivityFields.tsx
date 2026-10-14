import { Button, Checkbox, Input, InputNumber, Select, Space } from 'antd';
import { useState, type ReactNode } from 'react';
import { TenantDatePicker } from '../foundation/selectors.js';
import { editableRows } from '../foundation/forms/values.js';
import { useFormLock } from '../foundation/forms/FormLock.js';
import { RemoteSelect } from './runtime.js';
import { m, textValue } from './messages.js';
import { records, insertActivityChain } from './model.js';

export const EV = '/api/tenant/evaluation';
const paths: Record<string, string> = {
  typeId: `${EV}/activity-types`,
  cycleId: `${EV}/activity-cycles`,
  ownerOrgId: '/api/tenant/org/organizations',
  managerEmployeeId: `${EV}/candidates/review-members`,
  categoryIds: '/api/tenant/qualification/categories',
  levelIds: '/api/tenant/qualification/levels',
  noticeOrgRange: '/api/tenant/org/organizations',
};
export function ActivityControl({
  name,
  value,
  onChange,
  disabled,
}: {
  name: string;
  value?: unknown;
  onChange?: (value: unknown) => void;
  disabled?: boolean;
}) {
  const lock = useFormLock(disabled);
  disabled = lock.disabled;
  onChange = lock.guard(onChange);
  if (paths[name])
    return (
      <RemoteSelect
        path={paths[name]}
        value={value as string | string[]}
        onChange={onChange}
        multiple={['categoryIds', 'levelIds', 'noticeOrgRange'].includes(name)}
        disabled={disabled}
      />
    );
  if (name.endsWith('Date'))
    return <TenantDatePicker value={value as string} onChange={onChange} disabled={disabled} />;
  if (name === 'year' || name === 'maxLevelJump')
    return (
      <InputNumber
        value={value as number}
        onChange={onChange}
        min={name === 'year' ? 2000 : 1}
        max={name === 'year' ? 2100 : 5}
        precision={0}
        disabled={disabled}
      />
    );
  if (name === 'applicants') return <ApplicantTypes value={value} onChange={onChange} disabled={disabled} />;
  if (name === 'orgRange') return <OrgRanges value={records(value)} onChange={onChange} disabled={disabled} />;
  return (
    <Input
      aria-label={m[name as 'name']}
      value={value as string}
      onChange={(e) => onChange?.(e.target.value)}
      maxLength={200}
      disabled={disabled}
    />
  );
}
const applicantTypes = ['self', 'others'] as const;
// 不用 Checkbox.Group：它把受控 value 镜像进内部 state，点击后要等 effect 再渲染一轮，
// 这一轮之前界面仍是旧勾选，连续点击会拿旧 value 覆盖前一次操作。逐项受控在点击事件内即时反映，提交值保持选项顺序。
function ApplicantTypes({
  value,
  onChange,
  disabled,
}: {
  value?: unknown;
  onChange?: (value: unknown) => void;
  disabled?: boolean;
}) {
  const selected = Array.isArray(value) ? (value as string[]) : [];
  return (
    <div className="r3b-applicant-types">
      {applicantTypes.map((type) => (
        <Checkbox
          key={type}
          value={type}
          checked={selected.includes(type)}
          disabled={disabled}
          onChange={(e) =>
            onChange?.(applicantTypes.filter((t) => (t === type ? e.target.checked : selected.includes(t))))
          }
        >
          {m[type]}
        </Checkbox>
      ))}
    </div>
  );
}
function OrgRanges({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, unknown>[];
  onChange?: (value: unknown) => void;
  disabled?: boolean;
}) {
  const lock = useFormLock(disabled);
  disabled = lock.disabled;
  onChange = lock.guard(onChange);
  return (
    <Space direction="vertical" className="r3b-wide">
      <RemoteSelect
        path="/api/tenant/org/organizations"
        multiple
        disabled={disabled}
        value={value.map((r) => String(r.orgId))}
        onChange={(ids) =>
          onChange?.(
            (ids as string[]).map((id) => value.find((r) => r.orgId === id) ?? { orgId: id, includeDescendants: true }),
          )
        }
      />
      {value.map((row, index) => (
        <Checkbox
          key={String(row.orgId)}
          checked={row.includeDescendants === true}
          disabled={disabled}
          onChange={(e) =>
            onChange?.(value.map((r, i) => (i === index ? { ...r, includeDescendants: e.target.checked } : r)))
          }
        >
          {m.includeDescendants} · {textValue(row.orgId)}
        </Checkbox>
      ))}
    </Space>
  );
}
export function Repeated({
  value,
  onChange,
  create,
  children,
  disabled,
  max = 100,
}: {
  value: Record<string, unknown>[];
  onChange(value: Record<string, unknown>[]): void;
  create?: () => Record<string, unknown>;
  disabled?: boolean;
  max?: number;
  children(row: Record<string, unknown>, set: (key: string, value: unknown) => void, index: number): ReactNode;
}) {
  const lock = useFormLock(disabled);
  const actions = useFormLock(disabled || !create);
  disabled = lock.disabled;
  onChange = lock.guard(onChange);
  return (
    <div>
      {value.map((row, index) => (
        <section className="r3b-repeat" key={index}>
          {children(row, (key, v) => onChange(value.map((r, i) => (i === index ? { ...r, [key]: v } : r))), index)}
          {create && !disabled && (
            <Button type="link" danger onClick={actions.guard(() => onChange(value.filter((_, i) => i !== index)))}>
              {m.remove}
            </Button>
          )}
        </section>
      ))}
      {create && !disabled && (
        <Button onClick={actions.guard(() => onChange([...value, create()]))} disabled={value.length >= max}>
          {m.add}
        </Button>
      )}
    </div>
  );
}
export function Chains({
  value = [],
  onChange,
  locked,
  latest,
  disabled,
}: {
  value?: Record<string, unknown>[];
  onChange?: (value: unknown) => void;
  locked?: boolean;
  latest?: unknown;
  disabled?: boolean;
}) {
  const lock = useFormLock(disabled);
  disabled = lock.disabled;
  onChange = lock.guard(onChange);
  if (locked && latest) value = editableChains(latest, value);
  const change = (next: Record<string, unknown>[]) =>
    onChange?.(next.length > value.length ? insertActivityChain(value, next[next.length - 1]!) : next);
  const move = (index: number, direction: number) => {
    const next = [...value];
    const target = index + direction;
    [next[index], next[target]] = [next[target]!, next[index]!];
    change(next);
  };
  return (
    <Repeated
      value={value}
      onChange={change}
      disabled={disabled}
      max={8}
      create={locked ? undefined : () => ({ type: 'material', name: m.material, transferMode: 'auto' })}
    >
      {(row, set, index) => (
        <>
          <ChainFields
            row={row}
            set={set}
            disabled={disabled}
            locked={locked}
            replace={(next) => change(value.map((r) => (r === row ? next : r)))}
          />
          {!disabled && index > 0 && index < value.length - 1 && (
            <Space>
              <Button disabled={index <= 1} onClick={() => move(index, -1)}>
                {m.moveUp}
              </Button>
              <Button disabled={index >= value.length - 2} onClick={() => move(index, 1)}>
                {m.moveDown}
              </Button>
            </Space>
          )}
        </>
      )}
    </Repeated>
  );
}
export function Conditions({
  value = [],
  onChange,
  disabled,
}: {
  value?: Record<string, unknown>[];
  onChange?: (value: unknown) => void;
  disabled?: boolean;
}) {
  const lock = useFormLock(disabled);
  disabled = lock.disabled;
  onChange = lock.guard(onChange);
  return (
    <Repeated
      value={value}
      onChange={(v) => onChange?.(v)}
      disabled={disabled}
      create={() => ({ kind: 'common', applicantKind: 'self', details: [], expression: null })}
    >
      {(row, set) => <ConditionFields row={row} set={set} disabled={disabled} />}
    </Repeated>
  );
}

interface RowEditorProps {
  row: Record<string, unknown>;
  set(key: string, value: unknown): void;
  disabled?: boolean;
}
function ChainFields({
  row,
  set,
  disabled,
  locked,
  replace,
}: RowEditorProps & {
  locked?: boolean;
  replace(row: Record<string, unknown>): void;
}) {
  const fixed = useFormLock(disabled || locked);
  return (
    <div className="r3b-form-grid">
      <label>
        {m.chains}
        <Select
          className="r3b-wide"
          value={String(row.type)}
          disabled={disabled || locked}
          options={['apply', 'material', 'defense', 'result'].map((key) => ({
            value: key,
            label: m[key as 'apply'],
          }))}
          onChange={fixed.guard((type) =>
            replace({
              ...(row.id ? { id: row.id } : {}),
              type,
              name: m[type as 'apply'],
              startDate: row.startDate,
              endDate: row.endDate,
              transferMode: ['apply', 'material'].includes(type) ? 'auto' : 'manual',
            }),
          )}
        />
      </label>
      <label>
        {m.chainName}
        <Input value={String(row.name ?? '')} onChange={(e) => set('name', e.target.value)} disabled={disabled} />
      </label>
      {(['startDate', 'endDate'] as const).map((key) => (
        <label key={key}>
          {m[key]}
          <TenantDatePicker value={row[key] as string} onChange={(v) => set(key, v)} disabled={disabled} />
        </label>
      ))}
      {['apply', 'material'].includes(String(row.type)) && (
        <label>
          {m.approvalProcessCode}
          <Input
            value={String(row.approvalProcessCode ?? '')}
            onChange={(e) => set('approvalProcessCode', e.target.value)}
            disabled={disabled}
          />
        </label>
      )}
      {row.type === 'defense' && (
        <label>
          {m.formId}
          <RemoteSelect
            path={`${EV}/evaluation-forms`}
            value={row.formId as string}
            disabled={disabled || locked}
            onChange={fixed.guard((v) => set('formId', v))}
          />
        </label>
      )}
      <ChainOptions row={row} set={set} disabled={disabled} locked={locked} />
    </div>
  );
}

function ConditionFields({ row, set, disabled }: RowEditorProps) {
  return (
    <>
      <div className="r3b-form-grid">
        <label>
          {m.conditions}
          <Select
            className="r3b-wide"
            value={row.kind as string}
            disabled={disabled}
            options={['common', 'extra'].map((v) => ({ value: v, label: m[v as 'common'] }))}
            onChange={(v) => set('kind', v)}
          />
        </label>
        <label>
          {m.applicants}
          <Select
            className="r3b-wide"
            value={row.applicantKind as string}
            disabled={disabled}
            options={['self', 'others'].map((v) => ({ value: v, label: m[v as 'self'] }))}
            onChange={(v) => set('applicantKind', v)}
          />
        </label>
        {row.kind === 'extra' &&
          ['categoryIds', 'levelIds'].map((key) => (
            <label key={key}>
              {m[key as 'categoryIds']}
              <ActivityControl name={key} value={row[key]} disabled={disabled} onChange={(v) => set(key, v)} />
            </label>
          ))}
      </div>
      <p className="r3b-note">{m.sourceHint}</p>
      <Repeated
        value={records(row.details)}
        onChange={(v) => set('details', v)}
        disabled={disabled}
        create={() => ({
          seq: Math.max(0, ...records(row.details).map((r) => Number(r.seq))) + 1,
          source: '',
          field: '',
          operator: 'eq',
          value1: '',
        })}
      >
        {(row, set) => (
          <ConditionDetail key={`${row.seq}/${row.source}/${row.field}`} row={row} set={set} disabled={disabled} />
        )}
      </Repeated>
      <label>
        {m.expression}
        <Input
          value={String(row.expression ?? '')}
          disabled={disabled}
          onChange={(e) => set('expression', e.target.value || null)}
        />
      </label>
    </>
  );
}

function ChainOptions({ row, set, disabled, locked }: RowEditorProps & { locked?: boolean }) {
  const fixed = useFormLock(disabled || locked);
  return (
    <>
      {' '}
      {row.type !== 'result' && (
        <label>
          {m.transferMode}
          <Select
            value={row.transferMode as string}
            disabled={disabled}
            options={(row.type === 'defense' ? ['manual'] : ['auto', 'manual']).map((v) => ({
              value: v,
              label: m[v as 'auto'],
            }))}
            onChange={(v) => set('transferMode', v)}
          />
        </label>
      )}
      {row.type === 'apply' && (
        <Checkbox
          checked={row.hardDeadline === true}
          disabled={disabled || locked}
          onChange={fixed.guard((e) => set('hardDeadline', e.target.checked))}
        >
          {m.hardDeadline}
        </Checkbox>
      )}
    </>
  );
}

function ConditionDetail({ row, set, disabled }: RowEditorProps) {
  const [numeric] = useState(() => typeof row.value1 === 'number' || typeof row.value2 === 'number');
  return (
    <div className="r3b-form-grid">
      <span>
        {m.conditionDetails} #{String(row.seq)}
      </span>
      <span />
      <label>
        {m.operator}
        <Select
          value={row.operator as string}
          disabled={disabled}
          options={Object.entries(m.operators).map(([value, label]) => ({ value, label }))}
          onChange={(v) => set('operator', v)}
        />
      </label>
      {['source', 'field', 'value1', 'value2'].map((key) => (
        <label key={key}>
          {m[key as 'source']}
          {numeric && ['value1', 'value2'].includes(key) ? (
            <InputNumber value={row[key] as number | null} disabled={disabled} onChange={(value) => set(key, value)} />
          ) : (
            <Input value={String(row[key] ?? '')} disabled={disabled} onChange={(e) => set(key, e.target.value)} />
          )}
        </label>
      ))}
    </div>
  );
}

export function editableChains(latest: unknown, draft: unknown) {
  return editableRows(records(latest), records(draft), 'id', [
    'name',
    'startDate',
    'endDate',
    'approvalProcessCode',
    'transferMode',
  ]);
}
