// F-127b：列表筛选直连后端参数（list-query.ts），不再在前端过滤演示数据。
import { Alert, Checkbox, Input, InputNumber, Select } from 'antd';
import { useState, type ReactNode } from 'react';
import { FilterDrawer } from '../foundation/FilterDrawer.js';
import { PersonSelect, TenantDatePicker, type Choice } from '../foundation/selectors.js';
import { m } from './messages.js';
import { rangeErrors, sortFields, value as displayValue, type ListQuery, type View } from './model.js';
import { RefSelect, refPaths, usePeople } from './references.js';

/** 快速筛选：姓名 / 工号关键字，回车或失焦后应用。 */
export function KeywordFilter({ value, apply }: { value?: string; apply(keyword: string | undefined): void }) {
  const [draft, setDraft] = useState(value ?? '');
  const commit = () => {
    const next = draft.trim() || undefined;
    if (next !== value) apply(next);
  };
  return (
    <label className="contract-filter">
      <span>{m.keyword}</span>
      <Input
        aria-label={m.keyword}
        placeholder={m.keywordHint}
        maxLength={100}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onPressEnter={commit}
        onBlur={commit}
      />
    </label>
  );
}

const statuses = ['valid', 'terminated', 'void', 'in_review', 'approved', 'returned'];
function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="contract-filter">
      <span>{label}</span>
      {children}
    </label>
  );
}
type Draft = { draft: ListQuery; set(patch: ListQuery): void };
export function ListFilterDrawer({
  view,
  days,
  initial,
  onClose,
  onApply,
}: {
  view: View;
  days: number;
  initial: ListQuery;
  onClose(): void;
  onApply(filters: ListQuery, days: number): void;
}) {
  const [draft, setDraft] = useState(initial);
  const [draftDays, setDraftDays] = useState(days);
  const [invalid, setInvalid] = useState(false);
  const set = (patch: ListQuery) => {
    setInvalid(false);
    setDraft((previous) => ({ ...previous, ...patch }));
  };
  const missing = view === 'missing';
  return (
    <FilterDrawer
      open
      onClose={onClose}
      onClear={() => setDraft({})}
      onApply={() => {
        if (rangeErrors(draft).length) setInvalid(true);
        else onApply(draft, draftDays);
      }}
    >
      {invalid && <Alert type="error" showIcon message={m.rangeInvalid} />}
      <div className="contract-filter-grid">
        {view === 'expiring' && (
          <Item label={m.fields.days!}>
            <InputNumber
              aria-label={m.fields.days}
              min={1}
              max={3660}
              precision={0}
              value={draftDays}
              onChange={(next) => next && setDraftDays(next)}
            />
          </Item>
        )}
        <PersonItems draft={draft} set={set} />
        {!missing && <ContractItems draft={draft} set={set} />}
        <SortItems missing={missing} draft={draft} set={set} />
      </div>
    </FilterDrawer>
  );
}
function select({ draft, set }: Draft, key: string, label: string, options: { value: string; label: string }[]) {
  return (
    <Select
      allowClear
      aria-label={label}
      placeholder={m.choose}
      value={draft[key]}
      onChange={(next: string | undefined) => set({ [key]: next })}
      options={options}
    />
  );
}
/** 员工 / 姓名 / 部门 / 合同类型：六个视图都支持（入职缺失也认）。 */
function PersonItems({ draft, set }: Draft) {
  const people = usePeople();
  const employee: Choice | undefined = draft.employeeId
    ? { value: draft.employeeId, label: draft.employeeLabel ?? draft.employeeId }
    : undefined;
  const ref = (key: string, path: string, label: string) => (
    <RefSelect
      path={path}
      ariaLabel={label}
      value={draft[key] ?? null}
      onChange={(next) => set({ [key]: (next as string | null) ?? undefined })}
    />
  );
  return (
    <>
      <Item label={m.fields.employeeId!}>
        <PersonSelect
          load={people}
          value={employee}
          onChange={(next) => set({ employeeId: next?.value, employeeLabel: next?.label })}
        />
      </Item>
      <Item label={m.keyword}>
        <Input
          aria-label={m.keyword}
          placeholder={m.keywordHint}
          maxLength={100}
          value={draft.keyword ?? ''}
          onChange={(event) => set({ keyword: event.target.value || undefined })}
        />
      </Item>
      <Item label={m.fields.department!}>
        {ref('orgId', refPaths.orgId, m.fields.department!)}
        <Checkbox
          checked={draft.includeChildren === 'true'}
          disabled={!draft.orgId}
          onChange={(event) => set({ includeChildren: event.target.checked ? 'true' : undefined })}
        >
          {m.includeChildren}
        </Checkbox>
      </Item>
      <Item label={m.fields.typeId!}>{ref('typeId', refPaths.typeId, m.fields.typeId!)}</Item>
    </>
  );
}
function ContractItems(state: Draft) {
  const { draft, set } = state;
  const enumOptions = (key: string, values: string[]) =>
    values.map((id) => ({ value: id, label: displayValue(id, key) }));
  const range = (label: string, from: string, to: string) => (
    <Item label={label}>
      <span className="contract-range">
        <TenantDatePicker value={draft[from] ?? null} onChange={(next) => set({ [from]: next ?? undefined })} />
        <TenantDatePicker value={draft[to] ?? null} onChange={(next) => set({ [to]: next ?? undefined })} />
      </span>
    </Item>
  );
  return (
    <>
      <Item label={m.fields.companyId!}>
        <RefSelect
          path={refPaths.companyId}
          ariaLabel={m.fields.companyId}
          value={draft.companyId ?? null}
          onChange={(next) => set({ companyId: (next as string | null) ?? undefined })}
        />
      </Item>
      <Item label={m.fields.status!}>{select(state, 'status', m.fields.status!, enumOptions('status', statuses))}</Item>
      <Item label={m.fields.termType!}>
        {select(state, 'termType', m.fields.termType!, enumOptions('termType', ['fixed', 'indefinite', 'task']))}
      </Item>
      {range(m.effectiveRange, 'effectiveFrom', 'effectiveTo')}
      {range(m.endRange, 'endFrom', 'endTo')}
    </>
  );
}
function SortItems({ missing, ...state }: Draft & { missing: boolean }) {
  const fields = (missing ? ['name'] : sortFields).map((key) => ({ value: key, label: m.sortFields[key]! }));
  return (
    <>
      <Item label={m.sort}>{select(state, 'sort', m.sort, fields)}</Item>
      <Item label={m.order}>
        <Select
          aria-label={m.order}
          disabled={!state.draft.sort}
          value={state.draft.order ?? 'asc'}
          onChange={(next: string) => state.set({ order: next })}
          options={[
            { value: 'asc', label: m.asc },
            { value: 'desc', label: m.desc },
          ]}
        />
      </Item>
    </>
  );
}
