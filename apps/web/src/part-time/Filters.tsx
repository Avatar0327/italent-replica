import { Alert, Checkbox, Input, InputNumber, Select } from 'antd';
import { useEffect, useState } from 'react';
import { FilterDrawer } from '../foundation/FilterDrawer.js';
import { PersonSelect, type Choice } from '../foundation/selectors.js';
import { usePermissions } from '../foundation/Permissions.js';
import { RefSelect, usePeople } from '../contracts/references.js';
import { object, personObject, rangeInvalid, sortable, type Allowed, type Filters, type View } from './model.js';
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
        employeeIds: 'employeeId',
        serviceTypes: 'serviceType',
        serviceStatuses: 'serviceStatus',
        current: 'partTimeView',
        pendingStatuses: 'status',
        statuses: 'status',
        kinds: 'kind',
      }[key as string] ?? key;
    return employment.field(field).visible;
  };
}
export function useSortPermission(view: View) {
  const employment = usePermissions(object);
  const person = usePermissions(personObject);
  return (key: string) => sortable(view, key) && (key === 'code' ? person : employment).field(key).visible;
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
  const set: DraftProps['set'] = (key, val) => {
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
        else onApply({ ...draft, keyword: draft.keyword?.trim() || undefined }, nextDays);
      }}
    >
      {invalid && <Alert type="error" message={m.rangeInvalid} />}
      <div className="part-time-filters">
        <BasicFilters draft={draft} set={set} allowed={allowed} days={nextDays} setDays={setDays} view={view} />
        <ReferenceFilters draft={draft} set={set} allowed={allowed} />
        <StateFilters draft={draft} set={set} allowed={allowed} view={view} />
        <DateFilters draft={draft} set={set} allowed={allowed} />
      </div>
    </FilterDrawer>
  );
}

type DraftProps = { draft: Filters; set<K extends keyof Filters>(key: K, value: Filters[K]): void; allowed: Allowed };
function BasicFilters({
  draft,
  set,
  allowed,
  days,
  setDays,
  view,
}: DraftProps & {
  days: number;
  setDays(days: number): void;
  view: View;
}) {
  return (
    <>
      {view === 'expiring' && (
        <label>
          {m.days}
          <InputNumber
            aria-label={m.days}
            min={1}
            max={365}
            precision={0}
            value={days}
            onChange={(next) => {
              if (next) setDays(next);
            }}
          />
        </label>
      )}
      {allowed('employeeIds') && (
        <label>
          {m.people}
          <PeopleFilter value={draft.employeeIds ?? []} onChange={(next) => set('employeeIds', next)} />
        </label>
      )}
      {allowed('serviceTypes') && (
        <label>
          {m.fields.serviceType}
          <Select
            aria-label={m.fields.serviceType}
            mode="multiple"
            allowClear
            value={draft.serviceTypes ?? []}
            onChange={(next: string[]) => set('serviceTypes', next)}
            options={Object.entries(m.serviceTypes).map(([value, label]) => ({ value, label }))}
          />
        </label>
      )}
    </>
  );
}
function PeopleFilter({ value, onChange }: { value: string[]; onChange(value: string[]): void }) {
  const load = usePeople();
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Choice[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        void load(query, controller.signal).then(
          (next) => {
            if (!controller.signal.aborted) {
              setOptions(next);
              setFailed(false);
            }
          },
          () => {
            if (!controller.signal.aborted) {
              setOptions([]);
              setFailed(true);
            }
          },
        ),
      200,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load, query]);
  const known = new Set(options.map((option) => option.value));
  return (
    <Select
      mode="multiple"
      showSearch
      allowClear
      filterOption={false}
      aria-label={m.people}
      value={value}
      onChange={onChange}
      onSearch={setQuery}
      status={failed ? 'error' : undefined}
      notFoundContent={failed ? m.peopleError : m.empty}
      options={[...options, ...value.filter((id) => !known.has(id)).map((id) => ({ value: id, label: id }))]}
    />
  );
}

type StateField = {
  key: 'serviceStatuses' | 'pendingStatuses' | 'kinds' | 'statuses';
  label: string | undefined;
  options: Record<string, string>;
  defaults: string[];
};
function stateFilters(view: View): StateField[] {
  const statuses = Object.fromEntries(Object.entries(m.statuses).filter(([key]) => key !== 'deleted'));
  switch (view) {
    case 'all':
      return [
        {
          key: 'serviceStatuses',
          label: m.fields.serviceStatus,
          options: m.serviceStatuses,
          defaults: ['serving', 'ended'],
        },
      ];
    case 'expiring':
      return [{ key: 'pendingStatuses', label: m.fields.pendingStatus, options: statuses, defaults: [] }];
    case 'in_approval':
      return [
        { key: 'kinds', label: m.fields.kind, options: m.kinds, defaults: [] },
        { key: 'statuses', label: m.fields.approvalStatus, options: statuses, defaults: ['in_review'] },
      ];
    default:
      return [];
  }
}
function StateFilters({ draft, set, allowed, view }: DraftProps & { view: View }) {
  return (
    <>
      {stateFilters(view).map(({ key: field, label, options, defaults }) => {
        return (
          allowed(field) && (
            <label key={field}>
              {label}
              <Select
                mode="multiple"
                allowClear
                aria-label={label}
                value={draft[field] ?? defaults}
                onChange={(next: string[]) => set(field, next.length ? next : undefined)}
                options={Object.entries(options).map(([value, label]) => ({ value, label }))}
              />
            </label>
          )
        );
      })}
      {view === 'all' && allowed('current') && (
        <label>
          {m.fields.current}
          <Select
            allowClear
            aria-label={m.fields.current}
            value={draft.current}
            onChange={(next: string | undefined) => set('current', next)}
            options={[
              { value: 'true', label: m.yes },
              { value: 'false', label: m.no },
            ]}
          />
        </label>
      )}
    </>
  );
}
function ReferenceFilters({ draft, set, allowed }: DraftProps) {
  const people = usePeople();
  return (
    <>
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
      {allowed('postId') && (
        <label>
          {m.fields.postId}
          <RefSelect
            path={refPaths.postId!}
            ariaLabel={m.fields.postId}
            value={draft.postId}
            onChange={(next) => set('postId', typeof next === 'string' ? next : undefined)}
          />
        </label>
      )}
    </>
  );
}
function DateFilters({ draft, set, allowed }: DraftProps) {
  return (
    <>
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
                  aria-label={`${m.fields[field]}${m.from}`}
                  value={draft[from] ?? ''}
                  onChange={(e) => set(from, e.target.value || undefined)}
                />
              </label>
              <label>
                {m.fields[field]}
                {m.to}
                <Input
                  type="date"
                  aria-label={`${m.fields[field]}${m.to}`}
                  value={draft[to] ?? ''}
                  onChange={(e) => set(to, e.target.value || undefined)}
                />
              </label>
            </div>
          ),
      )}
    </>
  );
}
