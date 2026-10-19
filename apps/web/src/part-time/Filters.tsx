import { Alert, Checkbox, Input, InputNumber, Select } from 'antd';
import { useState } from 'react';
import { FilterDrawer } from '../foundation/FilterDrawer.js';
import { PersonSelect } from '../foundation/selectors.js';
import { usePermissions } from '../foundation/Permissions.js';
import { RefSelect, usePeople } from '../contracts/references.js';
import { object, personObject, rangeInvalid, type Allowed, type Filters, type View } from './model.js';
import { refPaths } from './references.js';
import { m } from './messages.js';
export function useFilterPermission(): Allowed {
  const employment = usePermissions(object);
  const person = usePermissions(personObject);
  return (key) => {
    if (key === 'keyword') return person.field('name').visible && person.field('code').visible;
    const field =
      {
        includeChildren: 'departmentId',
        startFrom: 'effectiveDate',
        startTo: 'effectiveDate',
        endFrom: 'endDate',
        endTo: 'endDate',
      }[key as string] ?? key;
    return employment.field(field).visible;
  };
}
export function FiltersDrawer({
  initial,
  days,
  view,
  allowed,
  onClose,
  onApply,
}: {
  initial: Filters;
  days: number;
  view: View;
  allowed: Allowed;
  onClose(): void;
  onApply(filters: Filters, days: number): void;
}) {
  const [draft, setDraft] = useState(initial);
  const [nextDays, setDays] = useState(days);
  const [invalid, setInvalid] = useState(false);
  const people = usePeople();
  const set = (key: keyof Filters, val: string | undefined) => {
    setInvalid(false);
    setDraft((old) => ({ ...old, [key]: val }));
  };
  return (
    <FilterDrawer
      open
      onClose={onClose}
      onClear={() => {
        setDraft({});
        setInvalid(false);
      }}
      onApply={() => {
        if (rangeInvalid(draft)) setInvalid(true);
        else onApply(draft, nextDays);
      }}
    >
      {invalid && <Alert type="error" message={m.rangeInvalid} />}
      <div className="part-time-filters">
        {view === 'expiring' && (
          <label>
            {m.days}
            <InputNumber
              aria-label={m.days}
              min={1}
              max={365}
              precision={0}
              value={nextDays}
              onChange={(next) => {
                if (next) setDays(next);
              }}
            />
          </label>
        )}
        {allowed('keyword') && (
          <label>
            {m.keyword}
            <Input
              aria-label={m.keyword}
              maxLength={100}
              value={draft.keyword ?? ''}
              onChange={(e) => set('keyword', e.target.value.trim() || undefined)}
            />
          </label>
        )}
        {allowed('serviceType') && (
          <label>
            {m.fields.serviceType}
            <Select
              aria-label={m.fields.serviceType}
              allowClear
              value={draft.serviceType}
              onChange={(next: string | undefined) => set('serviceType', next)}
              options={Object.entries(m.serviceTypes).map(([value, label]) => ({ value, label }))}
            />
          </label>
        )}
        {allowed('departmentId') && (
          <div>
            <label>
              {m.fields.departmentId}
              <RefSelect
                path={refPaths.departmentId!}
                ariaLabel={m.fields.departmentId}
                value={draft.departmentId}
                onChange={(next) => set('departmentId', typeof next === 'string' ? next : undefined)}
              />
            </label>
            <Checkbox
              checked={draft.includeChildren !== 'false'}
              disabled={!draft.departmentId}
              onChange={(e) => set('includeChildren', String(e.target.checked))}
            >
              {m.includeChildren}
            </Checkbox>
          </div>
        )}
        {allowed('directManagerId') && (
          <label>
            {m.fields.directManagerId}
            <PersonSelect
              load={people}
              value={draft.directManagerId ? { value: draft.directManagerId, label: draft.directManagerId } : undefined}
              onChange={(next) => set('directManagerId', next?.value)}
            />
          </label>
        )}
        {(
          [
            ['startFrom', 'startTo', 'effectiveDate'],
            ['endFrom', 'endTo', 'endDate'],
          ] as const
        ).map(
          ([from, to, field]) =>
            allowed(from) && (
              <div key={field} className="part-time-range">
                <label>
                  {m.fields[field]}
                  {m.from}
                  <Input
                    type="date"
                    aria-label={`${m.fields[field]}{m.from}`}
                    value={draft[from] ?? ''}
                    onChange={(e) => set(from, e.target.value || undefined)}
                  />
                </label>
                <label>
                  {m.fields[field]}
                  {m.to}
                  <Input
                    type="date"
                    aria-label={`${m.fields[field]}{m.to}`}
                    value={draft[to] ?? ''}
                    onChange={(e) => set(to, e.target.value || undefined)}
                  />
                </label>
              </div>
            ),
        )}
      </div>
    </FilterDrawer>
  );
}
