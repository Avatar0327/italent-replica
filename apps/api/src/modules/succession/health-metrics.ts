/** §4.4 / SP-06：来源适配只取数，不自行过滤或聚合；所有分支交给 measureHealth。 */
import { type SuccessionLevelRow, type SyncNomination, type HealthMetric } from '@italent/domain';
import type { TalentReviewSyncPort } from '../talent-review/sync-port.js';
import { readOnDutyCount } from './org-stats.js';
import { healthDependencies, type HealthDependencies } from './health-dependencies.js';
import { orgHealthSourceStatus } from './health-source-access.js';
import { healthPeople, customHealthPopulation } from './health-population.js';
import type { healthPrincipal } from './health-principal.js';
import { type CalcContext, type CalcObject, CalcObjectFailure } from './calc-contract.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import { healthScalar, measureHealth, type HealthSource } from './health-measure.js';
export type HealthReads = Pick<
  TalentReviewSyncPort,
  'greenRate' | 'readReviewFields' | 'readSuccessionEntries' | 'listReviewFields'
>;
type MetricContext = [CalcContext, CalcObject, Awaited<ReturnType<typeof healthPrincipal>>, HealthReads];
export function healthMetricReader(...context: MetricContext): (row: SuccessionLevelRow) => Promise<HealthMetric> {
  return async (row) => {
    const dependencies = healthDependencies(row);
    return measureHealth(
      row,
      await readHealthSource(row, dependencies, context),
      context[0].run.businessDate,
      context[2].timezone,
      dependencies,
    );
  };
}
async function readHealthSource(
  row: SuccessionLevelRow,
  dependencies: HealthDependencies,
  context: MetricContext,
): Promise<HealthSource> {
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
  base.status = await orgHealthSourceStatus(tx, dependencies, {
    tenantId: run.tenantId,
    userId: principal.userId,
    orgId: object.objectId,
    today: principal.today,
  });
  if (base.status === 'forbidden') return base;
  const args = {
    tenantId: run.tenantId,
    orgIds: [object.objectId],
    context: { asOf: run.businessDate },
    viewer: { kind: 'principal' as const, userId: principal.userId },
  };
  if (dependencies.population === null) return readGreenSource(port, tx, args, base, object.objectId);
  const needSuccessors = dependencies.reads.has('successors');
  const entries = needSuccessors ? await port.readSuccessionEntries(tx, args) : [];
  if (needSuccessors && !entries.length) return { ...base, status: 'unavailable' };
  for (const status of ['forbidden', 'unavailable', 'module_absent'] as const)
    if (entries.some((e) => e.status === status)) return { ...base, status };
  const nominations = entries
    .flatMap((e) => e.nominations)
    .filter((n) => n.kind === 'org' && n.direction === 'successor' && n.orgId === object.objectId);
  const successors = [...new Set(nominations.map((n) => n.successorEmployeeId))];
  const [org] = dependencies.reads.has('incumbents')
    ? await loadOrgSnapshot(tx, run.tenantId, run.businessDate, undefined, {
        id: object.objectId,
        includeDisabled: false,
      })
    : [];
  const incumbents = org?.personInChargeId ? [org.personInChargeId] : [];
  const people = await selectPeople(row, dependencies, context, successors, incumbents);
  Object.assign(base, { population: people.length, successors: successors.length, incumbents: incumbents.length });
  if (dependencies.field === null) return { ...base, samples: people.map((key) => ({ key, read: healthScalar(1) })) };
  if (dependencies.field === 'successors') return readSuccessionSource(row, nominations, people, base);
  if (dependencies.field !== 'review') {
    base.field = { ...base.field, kind: dependencies.field === 'incumbents' ? 'text' : 'number' };
    if (dependencies.field === 'green_rate') return readGreenSource(port, tx, args, base, object.objectId);
    const value =
      dependencies.field === 'on_duty_count'
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
  dependencies: HealthDependencies,
  [ctx, object, principal]: MetricContext,
  successors: string[],
  incumbents: string[],
) {
  if (dependencies.population === 'successors') return successors;
  if (dependencies.population === 'incumbents') return incumbents;
  const people = await healthPeople(ctx.tx, ctx.run.tenantId, object.objectId, ctx.run.businessDate);
  if (dependencies.population !== 'custom') return people.map((p) => p.id);
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
  people: readonly string[],
  base: HealthSource,
): HealthSource {
  const readiness = row.fieldCode === 'readiness_code';
  return {
    ...base,
    succession: {
      original: nominations.length === 0 ? 'zero' : 'present',
      populationKeys: row.population === 'all' ? null : people,
      numeric: !readiness,
    },
    field: {
      object: 'successor',
      code: row.fieldCode ?? 'count',
      path: 'successor.value',
      kind: readiness ? 'text' : 'number',
    },
    samples: nominations.map((n) => ({
      key: n.successorEmployeeId,
      read: healthScalar(readiness ? n.readinessCode : 1),
    })),
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
