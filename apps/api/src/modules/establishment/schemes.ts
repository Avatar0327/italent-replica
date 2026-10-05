import { randomUUID } from 'node:crypto';
import {
  and,
  desc,
  eq,
  establishmentObjects,
  establishmentSchemeExclusions,
  establishmentSchemeObjects,
  establishmentSchemeRanges,
  establishmentSchemeVersions,
  gte,
  inArray,
  lte,
  ne,
  type Tx,
} from '@italent/db';
import { gt } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { assertOrg } from './org-reader.js';
import {
  assertRevision,
  audit,
  businessDate,
  invalid,
  lockEstablishment,
  today,
  type EstablishmentContext,
} from './store.js';

export interface OccupancyRange {
  readonly employmentType: string;
  readonly conditions?: Readonly<Record<string, readonly string[]>>;
}

export interface SchemeInput {
  readonly name: string;
  readonly code?: string;
  readonly periodType: 'annual' | 'quarterly' | 'monthly';
  readonly maintenanceMode: 'local' | 'inclusive' | 'both';
  readonly startMonth?: number;
  readonly subdivision?: 'none' | 'position';
  readonly unmatchedPolicy?: 'organization' | 'reject';
  readonly enabled?: boolean;
  readonly startDate?: string;
  readonly stopDate?: string;
  readonly excludedOrgIds?: readonly string[];
  readonly occupancyRanges?: readonly OccupancyRange[];
}

export interface SchemeRecord extends Omit<typeof establishmentSchemeVersions.$inferSelect, 'id'> {
  readonly id: string;
  readonly versionId: string;
  readonly revision: number;
  readonly periodType: SchemeInput['periodType'];
  readonly excludedOrgIds: readonly string[];
  readonly occupancyRanges: readonly OccupancyRange[];
}

export async function loadScheme(tx: Tx, tenantId: string, id: string, asOf: string): Promise<SchemeRecord> {
  const [row] = await tx
    .select({ object: establishmentSchemeObjects, version: establishmentSchemeVersions })
    .from(establishmentSchemeVersions)
    .innerJoin(
      establishmentSchemeObjects,
      and(
        eq(establishmentSchemeObjects.id, establishmentSchemeVersions.schemeId),
        eq(establishmentSchemeObjects.tenantId, establishmentSchemeVersions.tenantId),
      ),
    )
    .where(
      and(
        eq(establishmentSchemeVersions.tenantId, tenantId),
        eq(establishmentSchemeVersions.schemeId, id),
        lte(establishmentSchemeVersions.startDate, asOf),
      ),
    )
    .orderBy(desc(establishmentSchemeVersions.startDate), desc(establishmentSchemeVersions.versionNo))
    .limit(1);
  if (!row || row.version.stopDate < asOf) throw new AppError('NOT_FOUND', '编制方案在该时点不存在');
  const exclusions = await tx
    .select()
    .from(establishmentSchemeExclusions)
    .where(
      and(
        eq(establishmentSchemeExclusions.tenantId, tenantId),
        eq(establishmentSchemeExclusions.versionId, row.version.id),
      ),
    )
    .limit(101);
  const ranges = await tx
    .select()
    .from(establishmentSchemeRanges)
    .where(
      and(eq(establishmentSchemeRanges.tenantId, tenantId), eq(establishmentSchemeRanges.versionId, row.version.id)),
    )
    .orderBy(establishmentSchemeRanges.ordinal)
    .limit(6);
  if (exclusions.length > 100 || ranges.length > 5)
    throw new AppError('SERVICE_UNAVAILABLE', '方案条件超过单次处理预算');
  return {
    ...row.version,
    id: row.object.id,
    versionId: row.version.id,
    revision: row.object.revision,
    periodType: row.version.cycle,
    excludedOrgIds: exclusions.map((item) => item.orgId),
    occupancyRanges: ranges.map((item) => ({ employmentType: item.employmentType, conditions: item.conditions })),
  };
}

function normalize(ctx: EstablishmentContext, input: SchemeInput) {
  if (!input.name?.trim()) throw invalid('name', '方案名称必填');
  if (!['annual', 'quarterly', 'monthly'].includes(input.periodType)) throw invalid('periodType', '周期类型不合法');
  if (!['local', 'inclusive', 'both'].includes(input.maintenanceMode))
    throw invalid('maintenanceMode', '维护方式不合法');
  const startMonth = input.startMonth ?? 1;
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) throw invalid('startMonth', '起始月份不合法');
  const startDate = businessDate(input.startDate ?? today(ctx), 'startDate');
  const stopDate = businessDate(input.stopDate ?? '9999-12-31', 'stopDate');
  if (stopDate < startDate) throw invalid('stopDate', '失效日期不得早于生效日期');
  if ((input.occupancyRanges?.length ?? 0) > 5) throw invalid('occupancyRanges', '占编人员范围最多五条，按并集统计');
  if ((input.excludedOrgIds?.length ?? 0) > 100) throw invalid('excludedOrgIds', '不占编组织超过单次处理上限');
  for (const range of input.occupancyRanges ?? []) {
    if (!range.employmentType?.trim()) throw invalid('occupancyRanges', '雇佣类型条件不可为空');
    for (const [field, values] of Object.entries(range.conditions ?? {})) {
      if (
        ![
          'employType',
          'employmentForm',
          'employmentType',
          'employmentSource',
          'positionId',
          'postId',
          'levelId',
          'gradeId',
          'sequenceId',
          'dimension1',
          'dimension2',
          'dimension3',
          'dimension4',
          'dimension5',
        ].includes(field) ||
        !Array.isArray(values) ||
        !values.length ||
        values.length > 100 ||
        values.some((value) => typeof value !== 'string' || !value.trim() || value.length > 2000)
      )
        throw invalid('occupancyRanges', '占编条件字段或取值不合法');
    }
  }
  const code = input.code?.trim() ?? `es-${randomUUID().slice(0, 12)}`;
  if (!code || code.length > 64) throw invalid('code', '方案编码必须非空且不超过64字');
  return {
    code,
    name: input.name.trim(),
    cycle: input.periodType,
    maintenanceMode: input.maintenanceMode,
    startMonth,
    subdivision: input.subdivision ?? 'none',
    unmatchedPolicy: input.unmatchedPolicy ?? 'organization',
    enabled: input.enabled ?? true,
    startDate,
    stopDate,
  };
}

async function appendScheme(
  tx: Tx,
  ctx: EstablishmentContext,
  id: string,
  revision: number,
  input: SchemeInput,
  previous?: SchemeRecord,
) {
  const fields = normalize(ctx, input);
  const [duplicate] = await tx
    .select({ id: establishmentSchemeVersions.schemeId })
    .from(establishmentSchemeVersions)
    .where(
      and(
        eq(establishmentSchemeVersions.tenantId, ctx.tenantId),
        eq(establishmentSchemeVersions.code, fields.code),
        ne(establishmentSchemeVersions.schemeId, id),
      ),
    )
    .limit(1);
  if (duplicate) throw new AppError('CONFLICT', '方案编码已使用');
  const [version] = await tx
    .insert(establishmentSchemeVersions)
    .values({
      ...fields,
      tenantId: ctx.tenantId,
      schemeId: id,
      versionNo: revision,
      previousVersionId: previous?.versionId ?? null,
      createdAt: ctx.now,
    })
    .returning();
  if (!version) throw new AppError('SERVICE_UNAVAILABLE', '无法保存编制方案');
  const excludedOrgIds = [...new Set(input.excludedOrgIds ?? [])];
  for (const orgId of excludedOrgIds) await assertOrg(tx, ctx.tenantId, orgId, fields.startDate);
  if (excludedOrgIds.length)
    await tx
      .insert(establishmentSchemeExclusions)
      .values(excludedOrgIds.map((orgId) => ({ tenantId: ctx.tenantId, versionId: version.id, orgId })));
  const ranges = input.occupancyRanges ?? [];
  if (ranges.length)
    await tx.insert(establishmentSchemeRanges).values(
      ranges.map((range, index) => ({
        tenantId: ctx.tenantId,
        versionId: version.id,
        ordinal: index,
        employmentType: range.employmentType,
        conditions: Object.fromEntries(Object.entries(range.conditions ?? {}).map(([k, v]) => [k, [...v]])),
      })),
    );
  return loadScheme(tx, ctx.tenantId, id, fields.startDate);
}

export async function createScheme(tx: Tx, ctx: EstablishmentContext, input: SchemeInput): Promise<SchemeRecord> {
  assertRevision(ctx.expectedRevision, 0);
  await lockEstablishment(tx, ctx);
  const id = randomUUID();
  await tx.insert(establishmentSchemeObjects).values({ id, tenantId: ctx.tenantId, revision: 1 });
  const saved = await appendScheme(tx, ctx, id, 1, input);
  await audit(tx, ctx, 'establishment.scheme.create', 'establishment-scheme', id, null, saved);
  return saved;
}

export async function updateScheme(
  tx: Tx,
  ctx: EstablishmentContext,
  id: string,
  patch: Partial<SchemeInput> & { effectiveDate: string },
): Promise<SchemeRecord> {
  await lockEstablishment(tx, ctx);
  const date = businessDate(patch.effectiveDate);
  const [object] = await tx
    .select()
    .from(establishmentSchemeObjects)
    .where(and(eq(establishmentSchemeObjects.tenantId, ctx.tenantId), eq(establishmentSchemeObjects.id, id)))
    .limit(1);
  if (!object) throw new AppError('NOT_FOUND', '编制方案不存在');
  assertRevision(ctx.expectedRevision, object.revision);
  const [future] = await tx
    .select({ id: establishmentSchemeVersions.id })
    .from(establishmentSchemeVersions)
    .where(
      and(
        eq(establishmentSchemeVersions.tenantId, ctx.tenantId),
        eq(establishmentSchemeVersions.schemeId, id),
        gt(establishmentSchemeVersions.startDate, date),
      ),
    )
    .limit(1);
  if (future) throw new AppError('EST_FUTURE_VERSION_EXISTS', '方案已有后续版本');
  const previous = await loadScheme(tx, ctx.tenantId, id, date);
  await checkSchemeLifecycle(tx, ctx, previous, patch);
  await tx
    .update(establishmentSchemeObjects)
    .set({ revision: previous.revision + 1 })
    .where(and(eq(establishmentSchemeObjects.tenantId, ctx.tenantId), eq(establishmentSchemeObjects.id, id)));
  const saved = await appendScheme(
    tx,
    ctx,
    id,
    previous.revision + 1,
    { ...previous, ...patch, startDate: date },
    previous,
  );
  await audit(tx, ctx, 'establishment.scheme.update', 'establishment-scheme', id, previous, saved);
  return saved;
}

async function checkSchemeLifecycle(
  tx: Tx,
  ctx: EstablishmentContext,
  previous: SchemeRecord,
  patch: Partial<SchemeInput>,
): Promise<void> {
  const [reference] = await tx
    .select({ id: establishmentObjects.id })
    .from(establishmentObjects)
    .where(and(eq(establishmentObjects.tenantId, ctx.tenantId), eq(establishmentObjects.schemeId, previous.id)))
    .limit(1);
  const immutable =
    (patch.periodType !== undefined && patch.periodType !== previous.periodType) ||
    (patch.startMonth !== undefined && patch.startMonth !== previous.startMonth) ||
    (patch.subdivision !== undefined && patch.subdivision !== previous.subdivision);
  if (reference && immutable)
    throw new AppError('CONFLICT', '已引用方案不能修改周期或细分维度', { reason: 'SCHEME_REFERENCED' });
  const shortenedStop = patch.stopDate !== undefined && patch.stopDate < previous.stopDate;
  if (patch.enabled !== false && !shortenedStop) return;
  const [active] = await tx
    .select({ id: establishmentObjects.id })
    .from(establishmentObjects)
    .where(
      and(
        eq(establishmentObjects.tenantId, ctx.tenantId),
        eq(establishmentObjects.schemeId, previous.id),
        gte(establishmentObjects.periodEnd, today(ctx)),
        ...(patch.enabled !== false && patch.stopDate ? [gt(establishmentObjects.periodEnd, patch.stopDate)] : []),
      ),
    )
    .limit(1);
  if (active) throw new AppError('CONFLICT', '当前或未来编制仍引用该方案', { reason: 'SCHEME_IN_USE' });
}

export async function deleteScheme(tx: Tx, ctx: EstablishmentContext, id: string) {
  await lockEstablishment(tx, ctx);
  const previous = await loadScheme(tx, ctx.tenantId, id, today(ctx));
  assertRevision(ctx.expectedRevision, previous.revision);
  const [reference] = await tx
    .select({ id: establishmentObjects.id })
    .from(establishmentObjects)
    .where(and(eq(establishmentObjects.tenantId, ctx.tenantId), eq(establishmentObjects.schemeId, id)))
    .limit(1);
  if (reference) throw new AppError('CONFLICT', '已被编制引用的方案不能删除', { reason: 'SCHEME_REFERENCED' });
  const saved = await updateScheme(tx, ctx, id, { effectiveDate: today(ctx), enabled: false });
  await audit(tx, ctx, 'establishment.scheme.delete', 'establishment-scheme', id, previous, saved);
  return saved;
}

export function periodEnd(scheme: Pick<SchemeRecord, 'periodType' | 'startMonth'>, periodStart: string): string {
  const date = businessDate(periodStart, 'periodStart');
  const [year, month, day] = date.split('-').map(Number);
  if (day !== 1) throw invalid('periodStart', '编制周期必须从月初开始');
  const distance = (month! - scheme.startMonth + 12) % 12;
  if (scheme.periodType === 'annual' && distance !== 0) throw invalid('periodStart', '年度起始月与方案不符');
  if (scheme.periodType === 'quarterly' && distance % 3 !== 0) throw invalid('periodStart', '季度起始月与方案不符');
  const months = scheme.periodType === 'annual' ? 12 : scheme.periodType === 'quarterly' ? 3 : 1;
  const end = new Date(0);
  end.setUTCFullYear(year!, month! - 1 + months, 0);
  if (end.getUTCFullYear() > 9999) throw invalid('periodStart', '编制周期超出可用日期');
  return end.toISOString().slice(0, 10);
}

export function nextPeriod(start: string, scheme: Pick<SchemeRecord, 'periodType' | 'startMonth'>): string {
  const end = new Date(`${periodEnd(scheme, start)}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const next = end.toISOString().slice(0, 10);
  if (next.length !== 10) throw invalid('periodStart', '下一周期超出可用日期');
  return next;
}

/** 列表只批量读取本页方案，三个查询获取版本、排除组织和占编范围，避免逐行 N+1。 */
export async function loadSchemeBatch(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
  asOf: string,
): Promise<SchemeRecord[]> {
  if (!ids.length) return [];
  const rows = await tx
    .selectDistinctOn([establishmentSchemeVersions.schemeId], {
      object: establishmentSchemeObjects,
      version: establishmentSchemeVersions,
    })
    .from(establishmentSchemeVersions)
    .innerJoin(
      establishmentSchemeObjects,
      and(
        eq(establishmentSchemeObjects.id, establishmentSchemeVersions.schemeId),
        eq(establishmentSchemeObjects.tenantId, establishmentSchemeVersions.tenantId),
      ),
    )
    .where(
      and(
        eq(establishmentSchemeVersions.tenantId, tenantId),
        inArray(establishmentSchemeVersions.schemeId, [...ids]),
        lte(establishmentSchemeVersions.startDate, asOf),
      ),
    )
    .orderBy(
      establishmentSchemeVersions.schemeId,
      desc(establishmentSchemeVersions.startDate),
      desc(establishmentSchemeVersions.versionNo),
    );
  const current = rows.filter(({ version }) => version.stopDate >= asOf);
  const versionIds = current.map(({ version }) => version.id);
  if (!versionIds.length) return [];
  const exclusions = await tx
    .select()
    .from(establishmentSchemeExclusions)
    .where(
      and(
        eq(establishmentSchemeExclusions.tenantId, tenantId),
        inArray(establishmentSchemeExclusions.versionId, versionIds),
      ),
    )
    .limit(ids.length * 101);
  const ranges = await tx
    .select()
    .from(establishmentSchemeRanges)
    .where(
      and(eq(establishmentSchemeRanges.tenantId, tenantId), inArray(establishmentSchemeRanges.versionId, versionIds)),
    )
    .orderBy(establishmentSchemeRanges.ordinal)
    .limit(ids.length * 6);
  return current.map(({ object, version }) => {
    const excluded = exclusions.filter((item) => item.versionId === version.id);
    const occupancy = ranges.filter((item) => item.versionId === version.id);
    if (excluded.length > 100 || occupancy.length > 5)
      throw new AppError('SERVICE_UNAVAILABLE', '方案条件超过单次处理预算');
    return {
      ...version,
      id: object.id,
      versionId: version.id,
      revision: object.revision,
      periodType: version.cycle,
      excludedOrgIds: excluded.map((item) => item.orgId),
      occupancyRanges: occupancy.map((item) => ({ employmentType: item.employmentType, conditions: item.conditions })),
    };
  });
}
