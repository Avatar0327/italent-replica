/** §4.4 / SP-06：来源适配只取数，不自行过滤或聚合；所有分支交给 measureHealth。 */
import { type SuccessionLevelRow, type SyncNomination, type HealthMetric } from '@italent/domain';
import type { TalentReviewSyncPort } from '../talent-review/sync-port.js';
import { readOnDutyCount } from './org-stats.js';
import { healthPeople, customHealthPopulation } from './health-population.js';
import type { healthPrincipal } from './health-principal.js';
import { type CalcContext, type CalcObject, CalcObjectFailure } from './calc-contract.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import { healthScalar, measureHealth, type HealthSource, type HealthSample } from './health-measure.js';
export type HealthReads = Pick<
  TalentReviewSyncPort,
  'greenRate' | 'readReviewFields' | 'readSuccessionEntries' | 'listReviewFields'
>;
type MetricContext = [CalcContext, CalcObject, Awaited<ReturnType<typeof healthPrincipal>>, HealthReads];
export function healthMetricReader(...context: MetricContext): (row: SuccessionLevelRow) => Promise<HealthMetric> {
  return async (row) =>
    measureHealth(row, await readHealthSource(row, context), context[0].run.businessDate, context[2].timezone);
}
async function readHealthSource(row: SuccessionLevelRow, context: MetricContext): Promise<HealthSource> {
  const [ctx, object, principal, port] = context,
    { tx, run } = ctx;
  const base: HealthSource = {
    status: 'value',
    samples: [],
    population: 0,
    successors: 0,
    incumbents: 0,
    field: { object: 'org', code: row.fieldCode ?? 'count', path: 'org.value', kind: 'number' },
  };
  const args = {
    tenantId: run.tenantId,
    orgIds: [object.objectId],
    context: { asOf: run.businessDate },
    viewer: { kind: 'principal' as const, userId: principal.userId },
  };
  if (row.measure === 'green_rate') return readGreenSource(port, tx, args, base, object.objectId);
  const needSuccessors =
    row.fieldSource === 'succession' || row.population === 'successors' || row.measure === 'count_over_successors';
  const entries = needSuccessors ? await port.readSuccessionEntries(tx, args) : [];
  if (needSuccessors && !entries.length) return { ...base, status: 'unavailable' };
  for (const status of ['forbidden', 'unavailable', 'module_absent'] as const)
    if (entries.some((e) => e.status === status)) return { ...base, status };
  const nominations = entries
    .flatMap((e) => e.nominations)
    .filter((n) => n.kind === 'org' && n.direction === 'successor' && n.orgId === object.objectId);
  const successors = [...new Set(nominations.map((n) => n.successorEmployeeId))];
  const [org] = await loadOrgSnapshot(tx, run.tenantId, run.businessDate, undefined, {
    id: object.objectId,
    includeDisabled: false,
  });
  const incumbents = org?.personInChargeId ? [org.personInChargeId] : [];
  const people = await selectPeople(row, context, successors, incumbents);
  Object.assign(base, { population: people.length, successors: successors.length, incumbents: incumbents.length });
  const scoped = nominations.filter((n) => row.population === 'all' || people.includes(n.successorEmployeeId));
  if (row.fieldCode === null && row.measure !== 'successor_count')
    return { ...base, samples: people.map((key) => ({ key, read: healthScalar(1) })) };
  if (row.fieldSource === 'succession') return readSuccessionSource(row, scoped, base);
  if (row.fieldSource === 'org') {
    base.field = { ...base.field, kind: row.fieldCode === 'person_in_charge_id' ? 'text' : 'number' };
    if (row.fieldCode === 'green_rate') return readGreenSource(port, tx, args, base, object.objectId);
    const value =
      row.fieldCode === 'on_duty_count'
        ? await readOnDutyCount(tx, {
            tenantId: run.tenantId,
            orgId: object.objectId,
            asOf: run.businessDate,
            runId: run.id,
            now: ctx.now,
          })
        : (org?.personInChargeId ?? null);
    return { ...base, samples: [{ key: object.objectId, read: healthScalar(value) }] };
  }
  return readReviewSource(row, context, people, base);
}
async function selectPeople(
  row: SuccessionLevelRow,
  [ctx, object, principal]: MetricContext,
  successors: string[],
  incumbents: string[],
) {
  if (row.population === 'successors') return successors;
  if (row.population === 'incumbents') return incumbents;
  const people = await healthPeople(ctx.tx, ctx.run.tenantId, object.objectId, ctx.run.businessDate);
  if (row.population !== 'custom') return people.map((p) => p.id);
  return (
    await customHealthPopulation(
      ctx.tx,
      ctx.run.tenantId,
      principal.userId,
      principal.today,
      ctx.run.businessDate,
      principal.timezone,
      row.populationId!,
      people,
    )
  ).map((p) => p.id);
}
async function readGreenSource(
  port: HealthReads,
  tx: CalcContext['tx'],
  args: Parameters<HealthReads['greenRate']>[1],
  base: HealthSource,
  orgId: string,
): Promise<HealthSource> {
  const green = (await port.greenRate(tx, args)).get(orgId);
  if (!green) return { ...base, status: 'unavailable' };
  return { ...base, status: green.status, samples: [{ key: orgId, read: healthScalar(green.rate) }] };
}
function readSuccessionSource(
  row: SuccessionLevelRow,
  nominations: readonly SyncNomination[],
  base: HealthSource,
): HealthSource {
  const readiness = row.fieldCode === 'readiness_code';
  const count = new Set(nominations.map((n) => n.successorEmployeeId)).size;
  return {
    ...base,
    zeroNominations: nominations.length === 0,
    field: {
      object: 'successor',
      code: row.fieldCode ?? 'count',
      path: 'successor.value',
      kind: readiness ? 'text' : 'number',
    },
    samples: nominations
      .map<HealthSample>((n) => ({
        key: n.successorEmployeeId,
        read: healthScalar(readiness ? n.readinessCode : count),
      }))
      .concat(!readiness && !nominations.length ? [{ key: null, read: healthScalar(0) }] : []),
  };
}
async function readReviewSource(
  row: SuccessionLevelRow,
  [ctx, , principal, port]: MetricContext,
  people: readonly string[],
  base: HealthSource,
): Promise<HealthSource> {
  const { tx, run } = ctx;
  const descriptor = (await port.listReviewFields(tx, { tenantId: run.tenantId })).find(
    (f) => f.code === row.fieldCode,
  );
  if (!descriptor || !descriptor.formulaUsable)
    throw new CalcObjectFailure('DATA_UNAVAILABLE', true, undefined, row.rowNo);
  const reads = await port.readReviewFields(tx, {
    tenantId: run.tenantId,
    employeeIds: people,
    fieldCodes: [descriptor.code],
    context: { asOf: run.businessDate },
    viewer: { kind: 'principal', userId: principal.userId },
  });
  return {
    ...base,
    field: {
      object: 'review_object',
      code: descriptor.code,
      path: 'review_object.value',
      kind: descriptor.kind,
      optionDomain: descriptor.optionDomain,
    },
    samples: people.map((key) => ({
      key,
      read: reads.get(key)?.values[descriptor.code] ?? { status: 'unavailable', value: null },
    })),
  };
}
