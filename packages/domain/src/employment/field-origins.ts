/** F-036 §4.2–4.6：字段策略、覆盖与判定行的折叠不依赖载荷读取或数据库。 */
export const FIELD_ORIGIN_POLICIES = ['inherit', 'deferred', 'none', 'copy'] as const;
export const FIELD_ORIGIN_OVERRIDES = [
  'employee-input',
  'hr-input',
  'system-input',
  'approval-edit',
  'hr-record',
  'forward-update',
  'derive',
  'derive-edit',
  'sequence-sync',
  'status-propagate',
  'retain',
] as const;
export const FIELD_ORIGIN_ANCHORS = ['derive', 'derive-edit', 'sequence-sync'] as const;
export type FieldOriginPolicy = (typeof FIELD_ORIGIN_POLICIES)[number];
export type FieldOriginKind =
  FieldOriginPolicy | (typeof FIELD_ORIGIN_OVERRIDES)[number] | 'resolved' | 'fallback' | 'restore';
export type OriginDerivationRule = 'post-sequence' | 'position-sequence' | 'department-manager' | 'position-manager';

export interface OriginRow {
  readonly seq: bigint;
  readonly fieldCode: string;
  readonly originKind: FieldOriginKind;
  readonly value: unknown;
  readonly refSeq?: bigint | null;
  readonly reason?: string | null;
}

export const SAME_VALUE_CONFIRMATION = 'same-value-confirmation';
export const FORM_DEPENDENCY_RESET = 'form-dependency-reset';

export interface FieldOriginState<Row extends OriginRow = OriginRow> {
  readonly policy: FieldOriginPolicy | null;
  readonly policyRow: Row | null;
  readonly resolved: Row | null;
  readonly override: Row | null;
  readonly suspended: ReadonlySet<bigint>;
  readonly retained: boolean;
  readonly lastWriter: Row | null;
}

const policyKinds: ReadonlySet<FieldOriginKind> = new Set(FIELD_ORIGIN_POLICIES);

function isPolicy(kind: FieldOriginKind): kind is FieldOriginPolicy {
  return policyKinds.has(kind);
}

function valueRows<Row extends OriginRow>(state: FieldOriginState<Row>) {
  const policy = state.policy === 'inherit' || state.policy === 'copy' ? state.policyRow : null;
  return [state.override, state.resolved, policy];
}

export function effectiveOrigin<Row extends OriginRow>(state: FieldOriginState<Row> | undefined) {
  const lastWriter = state
    ? (valueRows(state).find((row) => row !== null && !state.suspended.has(row.seq)) ?? null)
    : null;
  return { value: lastWriter?.value ?? null, lastWriter };
}

type FoldingState<Row extends OriginRow> = {
  -readonly [Key in keyof FieldOriginState<Row>]: FieldOriginState<Row>[Key];
} & { suspended: Set<bigint> };

export function foldFieldOrigins<Row extends OriginRow>(rows: readonly Row[]): Map<string, FieldOriginState<Row>> {
  const states = new Map<string, FoldingState<Row>>();
  const ordered = [...rows].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  for (const row of ordered) {
    let state = states.get(row.fieldCode);
    if (!state) {
      state = {
        policy: null,
        policyRow: null,
        resolved: null,
        override: null,
        suspended: new Set(),
        retained: false,
        lastWriter: null,
      };
      states.set(row.fieldCode, state);
    }
    const kind = row.originKind;
    if (isPolicy(kind)) {
      state.policy = kind;
      state.policyRow = row;
    } else if (kind === 'resolved') {
      state.resolved = row;
    } else if (kind === 'fallback' || kind === 'restore') {
      if (row.refSeq == null) continue;
      if (kind === 'fallback' && row.reason === FORM_DEPENDENCY_RESET) {
        if (state.override?.seq === row.refSeq) {
          state.override = null;
          state.retained = false;
        }
      } else if (kind === 'fallback') state.suspended.add(row.refSeq);
      else state.suspended.delete(row.refSeq);
    } else {
      state.override = row;
      state.retained = kind === 'retain';
    }
  }
  for (const state of states.values()) state.lastWriter = effectiveOrigin(state).lastWriter;
  return states;
}

export interface FieldOriginInput {
  readonly fields?: object;
  readonly customFields?: object;
}

function inputEntries(body: FieldOriginInput): [string, unknown][] {
  return [
    ...Object.entries(body.fields ?? {}).map(([field, value]): [string, unknown] => [`preset:${field}`, value]),
    ...Object.entries(body.customFields ?? {}).map(([id, value]): [string, unknown] => [
      `custom:${id.toLowerCase()}`,
      value,
    ]),
  ];
}

export function requestInputFields(body: FieldOriginInput): ReadonlySet<string> {
  return new Set(inputEntries(body).map(([code]) => code));
}

const UUID_FIELDS = new Set([
  'preset:departmentId',
  'preset:positionId',
  'preset:postId',
  'preset:levelId',
  'preset:gradeId',
  'preset:directManagerId',
  'preset:dottedManagerId',
  'preset:employmentType',
  'preset:sequenceId',
  'preset:professionalLineId',
]);

function equalInputValue(code: string, before: unknown, after: unknown): boolean {
  if (before === after) return true;
  if (code === 'preset:addedSubordinateIds' && Array.isArray(before) && Array.isArray(after))
    return (
      before.length === after.length &&
      before.every(
        (value, index) =>
          typeof value === 'string' &&
          typeof after[index] === 'string' &&
          value.toLowerCase() === after[index].toLowerCase(),
      )
    );
  return (
    UUID_FIELDS.has(code) &&
    typeof before === 'string' &&
    typeof after === 'string' &&
    before.toLowerCase() === after.toLowerCase()
  );
}

export function changedInputFields(previous: FieldOriginInput, body: FieldOriginInput): ReadonlySet<string> {
  const saved = new Map(inputEntries(previous));
  return new Set(
    inputEntries(body)
      .filter(([code, value]) => !equalInputValue(code, saved.get(code) ?? null, value))
      .map(([code]) => code),
  );
}

export function isTrustedSavedValue(state: FieldOriginState | undefined, rule: ReadonlySet<FieldOriginKind>): boolean {
  const { lastWriter } = effectiveOrigin(state);
  return lastWriter !== null && rule.has(lastWriter.originKind);
}

const BUSINESS_DATES = new Set(['preset:effectiveDate', 'preset:lastWorkDate', 'preset:plannedEffectiveDate']);

const markerField = (code: string) => !code.startsWith('status:') && !BUSINESS_DATES.has(code);

export function projectOriginMarkers(
  states: ReadonlyMap<string, FieldOriginState>,
  legacy?: { explicitFieldCodes?: readonly string[]; deferredFieldCodes?: readonly string[] },
) {
  const explicit = new Set<string>();
  const deferred = new Set<string>();
  const previousExplicit = new Set(legacy?.explicitFieldCodes);
  const previousDeferred = legacy?.deferredFieldCodes ?? [];
  for (const [code, state] of states) {
    if (!markerField(code)) continue;
    const { lastWriter } = effectiveOrigin(state);
    if (lastWriter && lastWriter === state.override && lastWriter.originKind !== 'derive') {
      // S2 已有的同值确认行可能没有原因码，其旧标记仍能区分是否有一次实际改值。
      const recordEdit = lastWriter.originKind === 'hr-record';
      if (recordEdit && legacy ? previousExplicit.has(code) : lastWriter.reason !== SAME_VALUE_CONFIRMATION)
        explicit.add(code);
    }
    // F-036 §4.5：延迟字段一旦有了有效的值（人工覆盖或落地解析值）就不再待定；解析值被退回后重新待定。
    if (!lastWriter && state.policy === 'deferred') deferred.add(code);
  }
  for (const code of previousExplicit) if (markerField(code) && !states.has(code)) explicit.add(code);
  for (const code of previousDeferred)
    if (markerField(code) && !states.get(code)?.policy && !effectiveOrigin(states.get(code)).lastWriter)
      deferred.add(code);
  return {
    explicitFieldCodes: orderedMarkers(explicit, previousExplicit),
    deferredFieldCodes: orderedMarkers(deferred, previousDeferred),
  };
}

function orderedMarkers(codes: ReadonlySet<string>, previous: Iterable<string>) {
  return [...new Set([...previous].filter((code) => codes.has(code)).concat([...codes]))];
}

export function deferralShape(
  states: ReadonlyMap<string, FieldOriginState>,
): 'none' | 'department' | 'position' | 'both' {
  const department = states.get('preset:departmentId')?.policy === 'deferred';
  const position = states.get('preset:positionId')?.policy === 'deferred';
  if (department) return position ? 'both' : 'department';
  return position ? 'position' : 'none';
}

export function settleValueRows<Row extends OriginRow>(
  state: FieldOriginState<Row>,
  applies: (row: Row) => boolean | undefined,
) {
  const decisions: { fieldCode: string; originKind: 'restore' | 'fallback'; refSeq: bigint }[] = [];
  for (const row of valueRows(state)) {
    if (!row) continue;
    const applicable = applies(row);
    const suspended = state.suspended.has(row.seq);
    if (applicable === true && suspended)
      decisions.push({ fieldCode: row.fieldCode, originKind: 'restore', refSeq: row.seq });
    if (applicable === false && !suspended)
      decisions.push({ fieldCode: row.fieldCode, originKind: 'fallback', refSeq: row.seq });
  }
  return decisions;
}
