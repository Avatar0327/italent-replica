import { Alert, Button, Checkbox, Input, Select, Tag } from 'antd';
import { useEffect, useState } from 'react';
import { FilterDrawer } from '../foundation/FilterDrawer.js';
import { type Choice } from '../foundation/selectors.js';
import { usePermissions } from '../foundation/Permissions.js';
import { RefSelect, usePeople, useToday } from '../contracts/references.js';
import { object, personObject, filterError, sortable, type Allowed, type Filters, type View } from './model.js';
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
        requestSources: 'requestSource',
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
  view,
  allowed: permission,
  onClose,
  onApply,
}: {
  initial: Filters;
  view: View;
  allowed: Allowed;
  onClose(): void;
  onApply(filters: Filters): void;
}) {
  const today = useToday();
  const [draft, setDraft] = useState(initial);
  const allowed = (key: keyof Filters) => filterKeys(view, true).includes(key) && permission(key);
  const [invalid, setInvalid] = useState<string>();
  const set: DraftProps['set'] = (key, val) => {
    setInvalid(undefined);
    setDraft((old) => ({ ...old, [key]: val }));
  };
  return (
    <FilterDrawer
      open
      onClose={onClose}
      onClear={() => {
        setDraft({});
        setInvalid(undefined);
      }}
      onApply={() => {
        const error = filterError(view, draft, today);
        setInvalid(error);
        if (!error) onApply({ ...draft, keyword: draft.keyword?.trim() || undefined });
      }}
    >
      {invalid && <Alert type="error" message={invalid} />}
      <div className="part-time-filters">
        <BasicFilters draft={draft} set={set} allowed={allowed} />
        <ReferenceFilters draft={draft} set={set} allowed={allowed} />
        <StateFilters draft={draft} set={set} allowed={allowed} view={view} />
        <DateFilters draft={draft} set={set} allowed={allowed} />
      </div>
    </FilterDrawer>
  );
}

type DraftProps = { draft: Filters; set<K extends keyof Filters>(key: K, value: Filters[K]): void; allowed: Allowed };
function BasicFilters({ draft, set, allowed }: DraftProps) {
  return (
    <>
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
  key: 'serviceStatuses' | 'pendingStatuses' | 'kinds' | 'statuses' | 'requestSources';
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
        { key: 'requestSources', label: m.fields.requestSource, options: m.requestSources, defaults: [] },
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
                onChange={(next: string[]) => {
                  if (next.includes('*')) set(field, Object.keys(options));
                  else set(field, next.length ? next : undefined);
                }}
                options={[
                  ...(['requestSources', 'kinds'].includes(field) ? [{ value: '*', label: m.selectAll }] : []),
                  ...Object.entries(options).map(([value, label]) => ({ value, label })),
                ]}
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

/** F255A 逐视图对照表：快捷 / 高级筛选各自保留取证字段。 */
function filterKeys(view: View, advanced: boolean): (keyof Filters)[] {
  const common: (keyof Filters)[] = ['employeeIds', 'serviceTypes', 'departmentId', 'includeChildren', 'postId'];
  const start: (keyof Filters)[] = ['startFrom', 'startTo'];
  const end: (keyof Filters)[] = ['endFrom', 'endTo'];
  if (view === 'ongoing' || view === 'not_started') return advanced ? [] : [...common, ...start];
  if (view === 'ended') return advanced ? [] : [...common, ...end];
  if (view === 'expiring') return advanced ? [...common, ...end, 'pendingStatuses'] : end;
  if (view === 'all')
    return advanced ? [...common, ...start, ...end, 'serviceStatuses', 'current'] : ['serviceStatuses'];
  return advanced ? [...common, ...start, ...end, 'kinds', 'statuses', 'requestSources'] : [];
}
export const hasAdvancedFilters = (view: View) => filterKeys(view, true).length > 0;

export function QuickFilters({
  initial,
  view,
  allowed: permission,
  onApply,
}: {
  initial: Filters;
  view: View;
  allowed: Allowed;
  onApply(filters: Filters): void;
}) {
  const today = useToday();
  const end = today ? new Date(`${today}T00:00:00Z`) : undefined;
  end?.setUTCDate(end.getUTCDate() + 30);
  const [draft, setDraft] = useState<Filters>(() => ({
    ...(view === 'expiring' ? { endFrom: today, endTo: end?.toISOString().slice(0, 10) } : {}),
    ...initial,
  }));
  const [invalid, setInvalid] = useState<string>();
  const allowed = (key: keyof Filters) => filterKeys(view, false).includes(key) && permission(key);
  const set: DraftProps['set'] = (key, value) => {
    setInvalid(undefined);
    setDraft((old) => ({ ...old, [key]: value }));
  };
  return (
    <section aria-label={m.quick}>
      <div className="part-time-filters part-time-quick">
        <BasicFilters draft={draft} set={set} allowed={allowed} />
        <ReferenceFilters draft={draft} set={set} allowed={allowed} />
        <StateFilters draft={draft} set={set} allowed={allowed} view={view} />
        <DateFilters draft={draft} set={set} allowed={allowed} />
        {filterKeys(view, false).some(allowed) && (
          <Button
            onClick={() => {
              const error = filterError(view, draft, today);
              setInvalid(error);
              if (!error) onApply(draft);
            }}
          >
            {m.apply}
          </Button>
        )}
      </div>
      {invalid && <Alert type="error" message={invalid} />}
      {view === 'in_approval' &&
        Object.entries(initial)
          .filter(([key]) => permission(key as keyof Filters))
          .map(([key, value]) => (
            <Tag key={key} closable onClose={() => onApply({ ...initial, [key]: undefined })}>
              {filterTag(key, value!)}
            </Tag>
          ))}
    </section>
  );
}
function filterTag(key: string, value: string | string[]) {
  const names: Record<string, string | undefined> = {
    employeeIds: m.people,
    serviceTypes: m.fields.serviceType,
    departmentId: m.fields.departmentId,
    includeChildren: m.includeChildren,
    postId: m.fields.postId,
    kinds: m.fields.kind,
    statuses: m.fields.approvalStatus,
    requestSources: m.fields.requestSource,
    startFrom: `${m.fields.effectiveDate}${m.from}`,
    startTo: `${m.fields.effectiveDate}${m.to}`,
    endFrom: `${m.fields.endDate}${m.from}`,
    endTo: `${m.fields.endDate}${m.to}`,
  };
  const choices: Record<string, Record<string, string>> = {
    requestSources: m.requestSources,
    kinds: m.kinds,
    statuses: m.statuses,
    serviceTypes: m.serviceTypes,
  };
  let text: string;
  if (key === 'includeChildren') text = value === 'true' ? m.yes : m.no;
  else if (!Array.isArray(value)) text = value;
  else if (choices[key]) text = value.map((v) => choices[key]![v]).join('、');
  else text = m.selected(value.length);
  return `${names[key] ?? key}：${text}`;
}
