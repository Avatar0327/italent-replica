/** §4.4 / SP-06：只通过 T04 端口取盘点值；缓存人数用 C1，不能从地图或本地提名伪造盘点来源。 */
import {
  compileRuleSet,
  evaluateFormula,
  inMemorySubject,
  type PlainValue,
  type RuleFieldRef,
  type SuccessionLevelRow,
  type FieldRead,
  type SyncNomination,
  type HealthMetric,
  type GreenRateResult,
} from '@italent/domain';
import type { TalentReviewSyncPort } from '../talent-review/sync-port.js';
import { readOnDutyCount } from './org-stats.js';
import { healthPeople, customHealthPopulation } from './health-population.js';
import type { healthPrincipal } from './health-principal.js';
import type { CalcContext, CalcObject } from './calc-contract.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import { CalcObjectFailure } from './calc-contract.js';
export type HealthReads = Pick<
  TalentReviewSyncPort,
  'greenRate' | 'readReviewFields' | 'readSuccessionEntries' | 'listReviewFields'
>;
const scalar = (value: PlainValue): FieldRead => ({
  status: value === null || value === undefined ? 'empty' : 'value',
  value: value ?? null,
});
function matches(row: SuccessionLevelRow, value: PlainValue, field: RuleFieldRef, asOf: string, timezone: string) {
  if (!row.filterOperator) return value !== null && value !== undefined;
  const compiled = compileRuleSet(
    {
      expression: '1',
      rows: [{ rowNo: 1, kind: 'field', field, operator: row.filterOperator, values: row.filterValues }],
    },
    { resolve: () => field },
  );
  if (!compiled.ok) throw new CalcObjectFailure('RULE_ROW_INVALID', false, undefined, row.rowNo);
  const evaluated = evaluateFormula(compiled.compiled.formula, {
    calendar: { today: asOf, timeZone: timezone },
    subject: inMemorySubject('filter', { [field.path]: value }),
    fieldKind: () => (field.kind === 'option' ? 'text' : field.kind),
  });
  if (!evaluated.ok) throw new CalcObjectFailure(evaluated.failure.code, true, undefined, row.rowNo);
  return evaluated.value.kind === 'number' && evaluated.value.value === 1;
}
export function healthMetricReader(
  ctx: CalcContext,
  object: CalcObject,
  principal: Awaited<ReturnType<typeof healthPrincipal>>,
  port: HealthReads,
): (row: SuccessionLevelRow) => Promise<HealthMetric> {
  const { tx, run } = ctx,
    orgId = object.objectId,
    tenantId = run.tenantId,
    asOf = run.businessDate;
  const context = { asOf },
    viewer = { kind: 'principal' as const, userId: principal.userId };
  const succession = () => port.readSuccessionEntries(tx, { tenantId, orgIds: [orgId], context, viewer });
  return async (row: SuccessionLevelRow): Promise<HealthMetric> => {
    if (row.measure === 'green_rate') {
      const green = (await port.greenRate(tx, { tenantId, orgIds: [orgId], context, viewer })).get(orgId);
      if (!green || green.status === 'unavailable') return { status: 'unavailable' };
      if (green.status === 'forbidden') return { status: 'forbidden' };
      return green.rate === null ? { status: 'empty' } : { status: 'value', value: green.rate };
    }
    const needSuccessors =
      row.fieldSource === 'succession' || row.population === 'successors' || row.measure === 'count_over_successors';
    const entries = needSuccessors ? await succession() : [];
    if (needSuccessors && !entries.length) return { status: 'unavailable' };
    for (const status of ['forbidden', 'unavailable', 'module_absent'] as const)
      if (entries.some((e) => e.status === status)) return { status };
    const nominations = entries
      .flatMap((e) => e.nominations)
      .filter((n) => n.kind === 'org' && n.direction === 'successor' && n.orgId === orgId);
    const successors = [...new Set(nominations.map((n) => n.successorEmployeeId))];
    const [org] = await loadOrgSnapshot(tx, tenantId, asOf, undefined, { id: orgId, includeDisabled: false });
    const incumbents = org?.personInChargeId ? [org.personInChargeId] : [];
    let people: string[];
    if (row.population === 'successors') people = successors;
    else if (row.population === 'incumbents') people = incumbents;
    else people = (await healthPeople(tx, tenantId, orgId, asOf)).map((p) => p.id);
    if (row.population === 'custom')
      people = (
        await customHealthPopulation(
          tx,
          tenantId,
          principal.userId,
          principal.today,
          asOf,
          principal.timezone,
          row.populationId!,
          await healthPeople(tx, tenantId, orgId, asOf),
        )
      ).map((p) => p.id);
    const scopedNominations = nominations.filter(
      (n) => row.population === 'all' || people.includes(n.successorEmployeeId),
    );
    if (row.fieldCode === null && row.measure !== 'successor_count') {
      let denominator = 1;
      if (row.measure === 'count_over_successors') denominator = successors.length;
      if (row.measure === 'count_over_incumbents') denominator = incumbents.length;
      if (!people.length || !denominator) return { status: 'empty' };
      return { status: 'value', value: people.length / denominator };
    }
    const [values, field] = await loadHealthValues(
      row,
      [ctx, object, principal, port],
      people,
      scopedNominations,
      org?.personInChargeId ?? null,
    );
    return aggregateHealth(row, values, field, scopedNominations, successors, incumbents, asOf, principal.timezone);
  };
}

async function loadHealthValues(
  row: SuccessionLevelRow,
  [ctx, object, principal, port]: Parameters<typeof healthMetricReader>,
  people: readonly string[],
  nominations: readonly SyncNomination[],
  head: string | null,
): Promise<[FieldRead[], RuleFieldRef]> {
  const { tx, run, now } = ctx,
    orgId = object.objectId,
    tenantId = run.tenantId,
    asOf = run.businessDate;
  const context = { asOf },
    viewer = { kind: 'principal' as const, userId: principal.userId };
  let values: FieldRead[], field: RuleFieldRef;
  if (row.fieldSource === 'org') {
    let value: string | number | null | undefined | GreenRateResult = head;
    if (row.fieldCode === 'on_duty_count')
      value = await readOnDutyCount(tx, { tenantId, orgId, asOf, runId: run.id, now });
    if (row.fieldCode === 'green_rate')
      value = (await port.greenRate(tx, { tenantId, orgIds: [orgId], context, viewer })).get(orgId);
    values =
      typeof value === 'object' && value !== null
        ? [
            {
              status: value.status === 'value' ? scalar(value.rate).status : value.status,
              value: value.rate,
            },
          ]
        : [scalar(value)];
    field = {
      object: 'org',
      code: row.fieldCode ?? 'count',
      path: 'org.value',
      kind: row.fieldCode === 'person_in_charge_id' ? 'text' : 'number',
    };
  } else if (row.fieldSource === 'succession') {
    values =
      row.fieldCode === 'readiness_code'
        ? nominations.map((n) => scalar(n.readinessCode))
        : [scalar(new Set(nominations.map((n) => n.successorEmployeeId)).size)];
    field = {
      object: 'successor',
      code: row.fieldCode ?? 'count',
      path: 'successor.value',
      kind: row.fieldCode === 'readiness_code' ? 'text' : 'number',
    };
  } else {
    const descriptor = (await port.listReviewFields(tx, { tenantId })).find((f) => f.code === row.fieldCode);
    if (!descriptor || !descriptor.formulaUsable)
      throw new CalcObjectFailure('DATA_UNAVAILABLE', true, undefined, row.rowNo);
    field = {
      object: 'review_object',
      code: descriptor.code,
      path: 'review_object.value',
      kind: descriptor.kind,
      optionDomain: descriptor.optionDomain,
    };
    const reads = await port.readReviewFields(tx, {
      tenantId,
      employeeIds: people,
      fieldCodes: [descriptor.code],
      context,
      viewer,
    });
    values = people.map((id) => reads.get(id)?.values[descriptor.code] ?? { status: 'unavailable', value: null });
  }
  return [values, field];
}
function aggregateHealth(
  row: SuccessionLevelRow,
  values: FieldRead[],
  field: RuleFieldRef,
  nominations: readonly SyncNomination[],
  successors: readonly string[],
  incumbents: readonly string[],
  asOf: string,
  timezone: string,
): HealthMetric {
  for (const status of ['forbidden', 'unavailable'] as const)
    if (values.some((v) => v.status === status)) return { status };
  const nonempty = values.filter((v) => v.status === 'value');
  const selected = values.filter((v) => matches(row, v.value as PlainValue, field, asOf, timezone));
  let value = selected.length;
  if (row.measure === 'successor_count') {
    value =
      row.fieldCode === 'readiness_code'
        ? new Set(
            nominations
              .filter((n) => matches(row, n.readinessCode, field, asOf, timezone))
              .map((n) => n.successorEmployeeId),
          ).size
        : new Set(nominations.map((n) => n.successorEmployeeId)).size;
  } else if (row.measure === 'average') {
    const numbers = selected.map((v) => v.value);
    if (!numbers.length) return { status: 'empty' };
    if (numbers.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return { status: 'unavailable' };
    value = (numbers as number[]).reduce((sum, n) => sum + n, 0) / numbers.length;
  } else if (['ratio', 'review_result_ratio', 'count_over_successors', 'count_over_incumbents'].includes(row.measure)) {
    let denominator = values.length;
    if (row.measure === 'count_over_successors') denominator = successors.length;
    if (row.measure === 'count_over_incumbents') denominator = incumbents.length;
    if (row.measure === 'review_result_ratio') denominator = nonempty.length;
    if (!denominator) return { status: 'empty' };
    value /= denominator;
  }
  if (!values.length && row.measure !== 'successor_count') return { status: 'empty' };
  return { status: 'value', value };
}
