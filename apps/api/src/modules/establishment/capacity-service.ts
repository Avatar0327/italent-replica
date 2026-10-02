import { randomUUID } from 'node:crypto';
import {
  and,
  desc,
  eq,
  establishmentObjects,
  establishmentSubdivisions,
  establishmentVersions,
  jobPositionVersions,
  lte,
  type Tx,
} from '@italent/db';
import { gt } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { capacityFor, readCapacity, type CapacityRecord } from './capacity-read.js';
import { validateCapacity } from './constraints.js';
import { assertOrg, parentOrg, subtreeIds } from './org-reader.js';
import { loadScheme, nextPeriod, periodEnd, type SchemeRecord } from './schemes.js';
import {
  assertRevision,
  audit,
  businessDate,
  invalid,
  lockEstablishment,
  nonnegative,
  today,
  type EstablishmentContext,
} from './store.js';

export interface CapacityInput {
  readonly orgId: string;
  readonly schemeId: string;
  readonly periodStart: string;
  readonly effectiveDate?: string;
  readonly localCapacity?: number | null;
  readonly inclusiveCapacity?: number | null;
  readonly reservedLocal?: number;
  readonly reservedInclusive?: number;
  readonly strictControl?: boolean;
  readonly subdivisions?: readonly {
    positionId: string;
    localCapacity: number | null;
    inclusiveCapacity: number | null;
  }[];
  readonly syncParents?: boolean;
}

async function normalize(tx: Tx, ctx: EstablishmentContext, input: CapacityInput, scheme: SchemeRecord, date: string) {
  const mode = scheme.maintenanceMode;
  if (mode === 'local' && input.inclusiveCapacity != null)
    throw invalid('inclusiveCapacity', '仅本级维护方式不可手工维护含下级编制');
  if (mode === 'inclusive' && input.localCapacity != null)
    throw invalid('localCapacity', '仅含下级维护方式不可维护本级编制');
  const reservedLocal = nonnegative(input.reservedLocal ?? 0, 'reservedLocal');
  const reservedInclusive = nonnegative(input.reservedInclusive ?? 0, 'reservedInclusive');
  const parts = input.subdivisions ?? [];
  if (parts.length > 100) throw invalid('subdivisions', '细分条目超过单次处理上限');
  if (scheme.subdivision === 'none' && parts.length) throw invalid('subdivisions', '方案未启用职位细分');
  const seen = new Set<string>();
  const orgs = parts.length ? await subtreeIds(tx, ctx.tenantId, input.orgId, date) : [];
  for (const part of parts) {
    if (seen.has(part.positionId)) throw invalid('subdivisions', '细分职位不可重复');
    seen.add(part.positionId);
    const [position] = await tx
      .select()
      .from(jobPositionVersions)
      .where(
        and(
          eq(jobPositionVersions.tenantId, ctx.tenantId),
          eq(jobPositionVersions.objectId, part.positionId),
          lte(jobPositionVersions.startDate, date),
        ),
      )
      .orderBy(desc(jobPositionVersions.startDate), desc(jobPositionVersions.versionNo))
      .limit(1);
    if (!position || !position.enabled || position.stopDate < date || !orgs.includes(position.orgId))
      throw invalid('subdivisions', '职位不在本组织行政范围内生效');
    if (mode !== 'inclusive') nonnegative(part.localCapacity, 'subdivisions.localCapacity');
    else if (part.localCapacity !== null) throw invalid('subdivisions.localCapacity', '该维护方式不支持本级细分');
    if (mode !== 'local') nonnegative(part.inclusiveCapacity, 'subdivisions.inclusiveCapacity');
    else if (part.inclusiveCapacity !== null)
      throw invalid('subdivisions.inclusiveCapacity', '该维护方式不支持含下级细分');
    if (part.localCapacity != null && part.inclusiveCapacity != null && part.inclusiveCapacity < part.localCapacity)
      throw invalid('subdivisions', '细分含下级编制不得小于本级');
  }
  const generatedLocal = parts.reduce((n, p) => n + (p.localCapacity ?? 0), reservedLocal);
  const generatedInclusive = parts.reduce((n, p) => n + (p.inclusiveCapacity ?? 0), reservedInclusive);
  let local = mode === 'inclusive' ? null : input.localCapacity;
  let inclusive = mode === 'local' ? null : input.inclusiveCapacity;
  if (scheme.subdivision === 'position') {
    if (local != null && local !== generatedLocal)
      throw invalid('localCapacity', '细分方案本级总量由细分与预留自动计算');
    if (inclusive != null && inclusive !== generatedInclusive)
      throw invalid('inclusiveCapacity', '细分方案含下级总量由细分与预留自动计算');
    local = mode === 'inclusive' ? null : generatedLocal;
    inclusive = mode === 'local' ? null : generatedInclusive;
  }
  if (mode !== 'inclusive') local = nonnegative(local, 'localCapacity');
  if (mode !== 'local') inclusive = nonnegative(inclusive, 'inclusiveCapacity');
  if (local != null && inclusive != null && inclusive < local) throw invalid('inclusiveCapacity', '含下级不得小于本级');
  return {
    localCapacity: local ?? null,
    inclusiveCapacity: inclusive ?? null,
    reservedLocal,
    reservedInclusive,
    strictControl: input.strictControl ?? false,
    subdivisions: parts,
  };
}

async function append(
  tx: Tx,
  ctx: EstablishmentContext,
  id: string,
  revision: number,
  input: CapacityInput,
  previous?: CapacityRecord,
) {
  const date = businessDate(input.effectiveDate ?? (input.periodStart < today(ctx) ? input.periodStart : today(ctx)));
  const scheme = await loadScheme(tx, ctx.tenantId, input.schemeId, date);
  if (!scheme.enabled) throw invalid('schemeId', '编制方案已停用');
  const periodScheme = await loadScheme(
    tx,
    ctx.tenantId,
    input.schemeId,
    date < input.periodStart ? input.periodStart : date,
  );
  if (!periodScheme.enabled || periodScheme.stopDate < periodEnd(periodScheme, input.periodStart))
    throw invalid('schemeId', '编制周期引用的方案已停用或失效');
  await assertOrg(tx, ctx.tenantId, input.orgId, date);
  const fields = await normalize(tx, ctx, input, scheme, date);
  const [version] = await tx
    .insert(establishmentVersions)
    .values({
      tenantId: ctx.tenantId,
      objectId: id,
      versionNo: revision,
      previousVersionId: previous?.versionId ?? null,
      startDate: date,
      localCapacity: fields.localCapacity,
      inclusiveCapacity: fields.inclusiveCapacity,
      reservedLocal: fields.reservedLocal,
      reservedInclusive: fields.reservedInclusive,
      strictControl: fields.strictControl,
      createdAt: ctx.now,
    })
    .returning();
  if (!version) throw new AppError('SERVICE_UNAVAILABLE', '无法保存编制版本');
  if (fields.subdivisions.length)
    await tx
      .insert(establishmentSubdivisions)
      .values(fields.subdivisions.map((p) => ({ ...p, tenantId: ctx.tenantId, versionId: version.id })));
  return readCapacity(tx, ctx.tenantId, id, date);
}

export async function createCapacity(
  tx: Tx,
  ctx: EstablishmentContext,
  input: CapacityInput,
  options: { autoFill?: boolean } = {},
): Promise<CapacityRecord> {
  await ctx.authorizeCapacity?.(tx, { operation: 'create', orgId: input.orgId, payload: { ...input } });
  assertRevision(ctx.expectedRevision, 0);
  await lockEstablishment(tx, ctx);
  const date = businessDate(input.effectiveDate ?? (input.periodStart < today(ctx) ? input.periodStart : today(ctx)));
  const scheme = await loadScheme(tx, ctx.tenantId, input.schemeId, date);
  const end = periodEnd(scheme, input.periodStart);
  const [existing] = await tx
    .select({ id: establishmentObjects.id })
    .from(establishmentObjects)
    .where(
      and(
        eq(establishmentObjects.tenantId, ctx.tenantId),
        eq(establishmentObjects.orgId, input.orgId),
        eq(establishmentObjects.schemeId, input.schemeId),
        eq(establishmentObjects.periodStart, input.periodStart),
      ),
    )
    .limit(1);
  if (existing) throw new AppError('CONFLICT', '该组织、方案和周期已有编制', { reason: 'CAPACITY_EXISTS' });
  const id = randomUUID();
  await tx.insert(establishmentObjects).values({
    id,
    tenantId: ctx.tenantId,
    orgId: input.orgId,
    schemeId: input.schemeId,
    periodStart: input.periodStart,
    periodEnd: end,
    revision: 1,
    createdAt: ctx.now,
  });
  const saved = await append(tx, ctx, id, 1, input);
  if (input.syncParents)
    await syncAncestors(tx, ctx, { ...saved, inclusiveCapacity: 0, reservedInclusive: 0, subdivisions: [] }, saved);
  await validateCapacity(tx, ctx, saved);
  await audit(tx, ctx, 'establishment.capacity.create', 'establishment-capacity', id, null, saved);
  if (scheme.periodType === 'monthly' && options.autoFill !== false) {
    for (
      let period = nextPeriod(input.periodStart, scheme);
      period.slice(0, 4) === input.periodStart.slice(0, 4);
      period = nextPeriod(period, scheme)
    ) {
      const [exists] = await tx
        .select({ id: establishmentObjects.id })
        .from(establishmentObjects)
        .where(
          and(
            eq(establishmentObjects.tenantId, ctx.tenantId),
            eq(establishmentObjects.orgId, input.orgId),
            eq(establishmentObjects.schemeId, input.schemeId),
            eq(establishmentObjects.periodStart, period),
          ),
        )
        .limit(1);
      if (exists) continue;
      await createCapacity(tx, ctx, { ...input, periodStart: period, effectiveDate: date }, { autoFill: false });
    }
  }
  return saved;
}

export async function updateCapacity(
  tx: Tx,
  ctx: EstablishmentContext,
  id: string,
  patch: Partial<CapacityInput> & { effectiveDate: string; adjustmentThrough?: string },
): Promise<CapacityRecord> {
  await lockEstablishment(tx, ctx);
  const date = businessDate(patch.effectiveDate);
  const [object] = await tx
    .select()
    .from(establishmentObjects)
    .where(and(eq(establishmentObjects.tenantId, ctx.tenantId), eq(establishmentObjects.id, id)))
    .limit(1);
  if (!object) throw new AppError('NOT_FOUND', '组织编制不存在');
  await ctx.authorizeCapacity?.(tx, { operation: 'update', id, orgId: object.orgId, payload: { ...patch } });
  assertRevision(ctx.expectedRevision, object.revision);
  const [future] = await tx
    .select({ id: establishmentVersions.id })
    .from(establishmentVersions)
    .where(
      and(
        eq(establishmentVersions.tenantId, ctx.tenantId),
        eq(establishmentVersions.objectId, id),
        gt(establishmentVersions.startDate, date),
      ),
    )
    .limit(1);
  if (future) throw new AppError('EST_FUTURE_VERSION_EXISTS', '编制已有后续版本');
  const previous = await readCapacity(tx, ctx.tenantId, id, date);
  if (
    (patch.orgId && patch.orgId !== previous.orgId) ||
    (patch.schemeId && patch.schemeId !== previous.schemeId) ||
    (patch.periodStart && patch.periodStart !== previous.periodStart)
  )
    throw invalid('id', '编制对象的组织、方案和周期不可修改');
  const scheme = await loadScheme(tx, ctx.tenantId, previous.schemeId, date);
  const input: CapacityInput = {
    ...previous,
    ...patch,
    inclusiveCapacity:
      scheme.maintenanceMode === 'local'
        ? null
        : patch.inclusiveCapacity !== undefined
          ? patch.inclusiveCapacity
          : previous.inclusiveCapacity,
  };
  if (scheme.maintenanceMode === 'local' && patch.inclusiveCapacity != null)
    throw invalid('inclusiveCapacity', '仅本级维护方式不可手工维护含下级编制');
  const normalizedInput =
    scheme.subdivision === 'position'
      ? {
          ...input,
          localCapacity:
            patch.localCapacity === undefined && (patch.subdivisions !== undefined || patch.reservedLocal !== undefined)
              ? undefined
              : input.localCapacity,
          inclusiveCapacity:
            scheme.maintenanceMode === 'local'
              ? null
              : patch.inclusiveCapacity === undefined &&
                  (patch.subdivisions !== undefined || patch.reservedInclusive !== undefined)
                ? undefined
                : input.inclusiveCapacity,
        }
      : input;
  await tx
    .update(establishmentObjects)
    .set({ revision: previous.revision + 1 })
    .where(and(eq(establishmentObjects.tenantId, ctx.tenantId), eq(establishmentObjects.id, id)));
  const saved = await append(tx, ctx, id, previous.revision + 1, normalizedInput, previous);
  if (patch.syncParents) await syncAncestors(tx, ctx, previous, saved);
  await validateCapacity(tx, ctx, saved);
  await audit(tx, ctx, 'establishment.capacity.update', 'establishment-capacity', id, previous, saved);
  if (patch.adjustmentThrough) await propagate(tx, ctx, previous, saved, scheme, patch);

  return saved;
}

async function propagate(
  tx: Tx,
  ctx: EstablishmentContext,
  previous: CapacityRecord,
  saved: CapacityRecord,
  scheme: SchemeRecord,
  patch: { effectiveDate: string; adjustmentThrough?: string; syncParents?: boolean },
): Promise<void> {
  const date = patch.effectiveDate;
  const through = businessDate(patch.adjustmentThrough!, 'adjustmentThrough');
  if (scheme.periodType === 'annual' || through < previous.periodStart)
    throw invalid('adjustmentThrough', '月度或季度调整范围不得早于当前周期');
  periodEnd(scheme, through);
  const deltaLocal = (saved.localCapacity ?? 0) - (previous.localCapacity ?? 0);
  const deltaInclusive = (saved.inclusiveCapacity ?? 0) - (previous.inclusiveCapacity ?? 0);
  let visited = 0;
  for (let period = nextPeriod(previous.periodStart, scheme); period <= through; period = nextPeriod(period, scheme)) {
    if (++visited > 120) throw new AppError('PAYLOAD_TOO_LARGE', '单次向后调整最多120个周期');
    const target = await capacityFor(
      tx,
      ctx.tenantId,
      previous.orgId,
      previous.schemeId,
      period,
      date < period ? period : date,
    );
    if (!target) continue;
    await updateCapacity(tx, { ...ctx, expectedRevision: target.revision }, target.id, {
      effectiveDate: date < target.startDate ? target.startDate : date,
      ...(scheme.subdivision === 'position'
        ? {
            subdivisions: subdivisionDelta(previous, saved, target, scheme.maintenanceMode),
            reservedLocal: target.reservedLocal + saved.reservedLocal - previous.reservedLocal,
            reservedInclusive: target.reservedInclusive + saved.reservedInclusive - previous.reservedInclusive,
          }
        : {
            ...(target.localCapacity == null ? {} : { localCapacity: target.localCapacity + deltaLocal }),
            ...(scheme.maintenanceMode === 'local' || target.inclusiveCapacity == null
              ? {}
              : { inclusiveCapacity: target.inclusiveCapacity + deltaInclusive }),
          }),
      syncParents: patch.syncParents,
    });
  }
}

/** 18§4：各期保留自己的基值，按职位逐项增减；新增维度以该期零基值开始。 */
function subdivisionDelta(
  before: CapacityRecord,
  after: CapacityRecord,
  target: CapacityRecord,
  mode: SchemeRecord['maintenanceMode'],
  inclusiveOnly = false,
): CapacityInput['subdivisions'] {
  const oldParts = new Map(before.subdivisions.map((part) => [part.positionId, part]));
  const newParts = new Map(after.subdivisions.map((part) => [part.positionId, part]));
  const targetParts = new Map(target.subdivisions.map((part) => [part.positionId, part]));
  const ids = new Set([...oldParts.keys(), ...newParts.keys(), ...targetParts.keys()]);
  return [...ids].map((positionId) => ({
    positionId,
    localCapacity:
      mode === 'inclusive'
        ? null
        : (targetParts.get(positionId)?.localCapacity ?? 0) +
          (inclusiveOnly
            ? 0
            : (newParts.get(positionId)?.localCapacity ?? 0) - (oldParts.get(positionId)?.localCapacity ?? 0)),
    inclusiveCapacity:
      mode === 'local'
        ? null
        : (targetParts.get(positionId)?.inclusiveCapacity ?? 0) +
          (newParts.get(positionId)?.inclusiveCapacity ?? 0) -
          (oldParts.get(positionId)?.inclusiveCapacity ?? 0),
  }));
}

async function syncAncestors(
  tx: Tx,
  ctx: EstablishmentContext,
  before: CapacityRecord,
  after: CapacityRecord,
): Promise<void> {
  const seen = new Set<string>();
  const changed: CapacityRecord[] = [];
  for (
    let id = await parentOrg(tx, ctx.tenantId, after.orgId, after.startDate);
    id;
    id = await parentOrg(tx, ctx.tenantId, id, after.startDate)
  ) {
    if (seen.has(id) || seen.size >= 10000) throw new AppError('SERVICE_UNAVAILABLE', '行政链超出处理范围');
    seen.add(id);
    const parent = await capacityFor(tx, ctx.tenantId, id, after.schemeId, after.periodStart, after.startDate);
    if (!parent) continue;
    const scheme = await loadScheme(tx, ctx.tenantId, parent.schemeId, after.startDate);
    if (scheme.maintenanceMode === 'local') continue;
    await ctx.authorizeCapacity?.(tx, {
      operation: 'update',
      id: parent.id,
      orgId: parent.orgId,
      payload: {
        effectiveDate: after.startDate,
        ...(scheme.subdivision === 'position'
          ? {
              subdivisions: subdivisionDelta(before, after, parent, scheme.maintenanceMode, true),
              reservedInclusive: parent.reservedInclusive + after.reservedInclusive - before.reservedInclusive,
            }
          : {
              inclusiveCapacity:
                (parent.inclusiveCapacity ?? 0) + (after.inclusiveCapacity ?? 0) - (before.inclusiveCapacity ?? 0),
            }),
      },
    });
    const [future] = await tx
      .select({ id: establishmentVersions.id })
      .from(establishmentVersions)
      .where(
        and(
          eq(establishmentVersions.tenantId, ctx.tenantId),
          eq(establishmentVersions.objectId, parent.id),
          gt(establishmentVersions.startDate, after.startDate),
        ),
      )
      .limit(1);
    if (future) throw new AppError('EST_FUTURE_VERSION_EXISTS', '上级编制已有后续版本');
    await tx
      .update(establishmentObjects)
      .set({ revision: parent.revision + 1 })
      .where(and(eq(establishmentObjects.tenantId, ctx.tenantId), eq(establishmentObjects.id, parent.id)));
    const saved = await append(
      tx,
      ctx,
      parent.id,
      parent.revision + 1,
      {
        ...parent,
        effectiveDate: after.startDate,
        ...(scheme.subdivision === 'position'
          ? {
              subdivisions: subdivisionDelta(before, after, parent, scheme.maintenanceMode, true),
              reservedInclusive: parent.reservedInclusive + after.reservedInclusive - before.reservedInclusive,
              inclusiveCapacity: undefined,
            }
          : {
              inclusiveCapacity:
                (parent.inclusiveCapacity ?? 0) + (after.inclusiveCapacity ?? 0) - (before.inclusiveCapacity ?? 0),
            }),
      },
      parent,
    );
    changed.push(saved);
    await audit(tx, ctx, 'establishment.capacity.sync-parent', 'establishment-capacity', parent.id, parent, saved);
  }
  for (const parent of changed) await validateCapacity(tx, ctx, parent);
}
