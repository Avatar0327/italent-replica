import { and, eq, establishmentObjects, sql, transferEstablishmentAllocations, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { employmentCapacityContext } from '../permission/module-capacity-authorization.js';
import type { EmploymentContext, PresetFields } from '../employment/types.js';
import { validateCapacity } from './constraints.js';
import { employmentTimelineNeighbors } from '../employment/timeline.js';
import { loadEmploymentRecord } from '../employment/read-model.js';
import type { ActivationTarget, EstablishmentWarning } from '../employment/activation-checks.js';
import { readCapacity, type CapacityRecord } from './capacity-read.js';
import { updateCapacity } from './capacity-service.js';
import { loadScheme, type SchemeRecord } from './schemes.js';
import { audit, lockEstablishment, rowsOf, type EstablishmentContext } from './store.js';
import { carriedCandidates } from './carried-candidates.js';

type Allocation = typeof transferEstablishmentAllocations.$inferSelect;
type Delta = Pick<
  Allocation,
  'capacityId' | 'positionId' | 'localDelta' | 'inclusiveDelta' | 'reservedLocalDelta' | 'reservedInclusiveDelta'
>;

const signature = (rows: readonly Delta[]) =>
  rows
    .map((row) =>
      JSON.stringify([
        row.capacityId,
        row.positionId,
        row.localDelta,
        row.inclusiveDelta,
        row.reservedLocalDelta,
        row.reservedInclusiveDelta,
      ]),
    )
    .sort()
    .join('|');

/** DEC-181：保存即调编；调用者先锁员工/业务，之后按 org/locks.ts 取组织→编制锁，与严格控编共用。 */
export async function carryEstablishment(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  effectiveDate: string,
  source: Partial<PresetFields>,
  target: Partial<PresetFields>,
  warnings?: EstablishmentWarning[],
) {
  const context = await employmentCapacityContext(tx, ctx);
  await lockEstablishment(tx, context, { initializeDefault: false });
  if (!source.departmentId || !target.departmentId)
    throw new AppError('VALIDATION_FAILED', '带编调动必须有调出和调入部门');
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const records = await carriedCandidates(
    tx,
    context,
    [source.departmentId, target.departmentId],
    effectiveDate,
    today,
  );
  const capacities: { record: CapacityRecord; scheme: SchemeRecord }[] = [];
  for (const { id } of records) {
    try {
      const record = await readCapacity(tx, ctx.tenantId, id, today);
      const scheme = await loadScheme(tx, ctx.tenantId, record.schemeId, today);
      if (scheme.enabled && !scheme.excludedOrgIds.includes(record.orgId)) capacities.push({ record, scheme });
    } catch (error) {
      // 与 targetCapacities 同口径：尚未生效的对象不参与有效方案唯一性判断。
      if (!(error instanceof AppError && error.code === 'NOT_FOUND')) throw error;
    }
  }
  const sources = capacities.filter(({ record }) => record.orgId === source.departmentId);
  const targets = capacities.filter(({ record }) => record.orgId === target.departmentId);
  // TODO(需取证 #78)：多方案并存时不能自行决定转移哪一个方案或同时调编。
  if (sources.length > 1 || targets.length > 1)
    throw new AppError('CONFLICT', '带编调动的编制方案不唯一，分配规则待确认', {
      reason: 'ESTABLISHMENT_SCHEME_AMBIGUOUS',
    });
  // TODO(需取证 #78)：缺少成对编制对象时不自动创建，也不只调整一边。
  if (
    !sources.length ||
    !targets.length ||
    sources.length !== targets.length ||
    sources.some(
      ({ record }) =>
        !targets.some(
          ({ record: other }) => other.schemeId === record.schemeId && other.periodStart === record.periodStart,
        ),
    )
  )
    throw new AppError('CONFLICT', '调出和调入部门须有相同方案与周期的编制', { reason: 'ESTABLISHMENT_PAIR_REQUIRED' });
  const deltas: Delta[] = [];
  for (const { record, scheme } of sources) deltas.push(delta(record, scheme, source.positionId, -1));
  for (const { record, scheme } of targets) deltas.push(delta(record, scheme, target.positionId, 1));
  const existing = await carriedAllocations(tx, ctx.tenantId, businessId);
  if (signature(existing) === signature(deltas)) return;
  const released = existing.length ? await reverseCarriedEstablishment(tx, ctx, businessId) : [];
  // 同组织/职位相同仍按增减记历史；先加后减避免净零调动在零额度时出现中间负数。
  deltas.sort((a, b) => b.localDelta + b.inclusiveDelta - a.localDelta - a.inclusiveDelta);
  for (const change of deltas) {
    await applyDelta(tx, context, businessId, change, today);
    await tx
      .insert(transferEstablishmentAllocations)
      .values({ ...change, tenantId: ctx.tenantId, businessId, createdAt: ctx.now });
  }
  for (const id of new Set(deltas.map((change) => change.capacityId)))
    await validateCapacity(tx, context, await readCapacity(tx, ctx.tenantId, id, today));
  if (released.length) {
    const [business] = rowsOf<{ employeeId: string }>(
      await tx.execute(sql`
      SELECT employee_id AS "employeeId" FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${businessId}::uuid`),
    );
    if (business) await assertReleasedEstablishment(tx, ctx, businessId, business.employeeId, released, warnings);
  }
}

function delta(
  record: CapacityRecord,
  scheme: SchemeRecord,
  positionId: string | null | undefined,
  direction: 1 | -1,
): Delta {
  const part =
    scheme.subdivision === 'position' ? record.subdivisions.find((p) => p.positionId === positionId) : undefined;
  // TODO(需取证 #78)：调入无细分不能猜测新建细分或转入预留。
  if (scheme.subdivision === 'position' && direction === 1 && !part)
    throw new AppError('CONFLICT', '调入职位没有匹配的编制细分', {
      reason: 'ESTABLISHMENT_TARGET_SUBDIVISION_REQUIRED',
    });
  const localDelta = scheme.maintenanceMode === 'inclusive' ? 0 : direction;
  const inclusiveDelta = scheme.maintenanceMode === 'local' ? 0 : direction;
  return {
    capacityId: record.id,
    positionId: part?.positionId ?? null,
    localDelta,
    inclusiveDelta,
    reservedLocalDelta: scheme.subdivision === 'position' && !part ? localDelta : 0,
    reservedInclusiveDelta: scheme.subdivision === 'position' && !part ? inclusiveDelta : 0,
  };
}

async function applyDelta(
  tx: Tx,
  ctx: EstablishmentContext,
  businessId: string,
  change: Delta,
  date: string,
  action = 'adjust',
) {
  const before = await readCapacity(tx, ctx.tenantId, change.capacityId, date);
  const scheme = await loadScheme(tx, ctx.tenantId, before.schemeId, date);
  const reservedLocal = before.reservedLocal + change.reservedLocalDelta;
  const reservedInclusive = before.reservedInclusive + change.reservedInclusiveDelta;
  if (reservedLocal < 0 || reservedInclusive < 0)
    throw new AppError('CONFLICT', '调出部门的预留编制不足', { reason: 'ESTABLISHMENT_RESERVE_INSUFFICIENT' });
  if (change.positionId && !before.subdivisions.some((part) => part.positionId === change.positionId))
    throw new AppError('CONFLICT', '原调编细分已被删除，无法按原分配回退', {
      reason: 'ESTABLISHMENT_ALLOCATION_CHANGED',
    });
  const subdivisions = before.subdivisions.map((part) =>
    part.positionId !== change.positionId
      ? part
      : {
          ...part,
          localCapacity: part.localCapacity === null ? null : part.localCapacity + change.localDelta,
          inclusiveCapacity: part.inclusiveCapacity === null ? null : part.inclusiveCapacity + change.inclusiveDelta,
        },
  );
  if (
    subdivisions.some((p) => (p.localCapacity ?? 0) < 0 || (p.inclusiveCapacity ?? 0) < 0) ||
    (before.localCapacity !== null && before.localCapacity + change.localDelta < 0) ||
    (scheme.maintenanceMode !== 'local' &&
      before.inclusiveCapacity !== null &&
      before.inclusiveCapacity + change.inclusiveDelta < 0)
  )
    throw new AppError('CONFLICT', '调出部门的编制不足', { reason: 'ESTABLISHMENT_CAPACITY_INSUFFICIENT' });
  const after = await updateCapacity(
    tx,
    { ...ctx, expectedRevision: before.revision },
    before.id,
    {
      effectiveDate: date,
      reservedLocal,
      reservedInclusive,
      ...(scheme.subdivision === 'position'
        ? { subdivisions }
        : {
            localCapacity: before.localCapacity === null ? null : before.localCapacity + change.localDelta,
            inclusiveCapacity:
              scheme.maintenanceMode === 'local' || before.inclusiveCapacity === null
                ? null
                : before.inclusiveCapacity + change.inclusiveDelta,
          }),
    },
    { deferConstraints: true },
  );
  await audit(
    tx,
    ctx,
    `establishment.transfer.${action}`,
    'establishment-capacity',
    before.id,
    { businessId, capacity: before },
    { businessId, capacity: after, delta: change },
  );
}

export async function carriedAllocations(tx: Tx, tenantId: string, businessId: string) {
  return tx
    .select()
    .from(transferEstablishmentAllocations)
    .where(
      and(
        eq(transferEstablishmentAllocations.tenantId, tenantId),
        eq(transferEstablishmentAllocations.businessId, businessId),
        eq(transferEstablishmentAllocations.reversed, false),
      ),
    );
}

/** 删除/撤销反向追加原分配；不删除旧版本，不重新匹配可能已改变的职位细分。 */
export async function reverseCarriedEstablishment(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const context = await employmentCapacityContext(tx, ctx);
  // 无带编分配的普通业务无需额外取得编制锁。
  if (!(await carriedAllocations(tx, ctx.tenantId, businessId)).length) return [];
  await lockEstablishment(tx, context, { initializeDefault: false });
  const allocations = await carriedAllocations(tx, ctx.tenantId, businessId);
  // 回退按原分配授权全部对象，不能在授权另一侧前暴露任一侧的细分、预留或额度状态。
  for (const id of new Set(allocations.map((row) => row.capacityId))) {
    const [object] = await tx
      .select({ orgId: establishmentObjects.orgId })
      .from(establishmentObjects)
      .where(and(eq(establishmentObjects.tenantId, ctx.tenantId), eq(establishmentObjects.id, id)));
    if (!object) throw new AppError('NOT_FOUND', '编制在该时点不存在');
    await context.authorizeCapacityScope?.(tx, { operation: 'update', id, orgId: object.orgId });
  }
  const date = tenantLocalDate(ctx.now, ctx.timezone);
  for (const row of [...allocations].sort(
    (a, b) => a.localDelta + a.inclusiveDelta - b.localDelta - b.inclusiveDelta,
  )) {
    await applyDelta(
      tx,
      context,
      businessId,
      {
        capacityId: row.capacityId,
        positionId: row.positionId,
        localDelta: -row.localDelta,
        inclusiveDelta: -row.inclusiveDelta,
        reservedLocalDelta: -row.reservedLocalDelta,
        reservedInclusiveDelta: -row.reservedInclusiveDelta,
      },
      date,
      'reverse',
    );
    await tx
      .update(transferEstablishmentAllocations)
      .set({ reversed: true })
      .where(
        and(
          eq(transferEstablishmentAllocations.tenantId, ctx.tenantId),
          eq(transferEstablishmentAllocations.id, row.id),
        ),
      );
  }
  for (const id of new Set(allocations.map((row) => row.capacityId)))
    await validateCapacity(tx, context, await readCapacity(tx, ctx.tenantId, id, date));
  return allocations;
}

/** 编辑、重提与迟到跨周期复查使用当前任职插入点；相同分配幂等，不在到期时再次加编。 */
export async function reconcileCarriedEstablishment(
  tx: Tx,
  ctx: EmploymentContext,
  target: ActivationTarget,
  warnings?: EstablishmentWarning[],
) {
  if (target.occupancyOnly || target.reconcileCarried === false) return;
  const [request] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM transfer_requests
    WHERE tenant_id=${ctx.tenantId} AND business_id=${target.businessId}::uuid AND with_establishment`),
  );
  if (!request) return;
  const [materialized] = rowsOf<{ previousId: string | null }>(
    await tx.execute(sql`
    SELECT (SELECT p.record_id FROM employment_timeline p WHERE p.tenant_id=t.tenant_id
      AND p.employee_id=t.employee_id AND (p.start_date,p.sort_order)<(t.start_date,t.sort_order)
      ORDER BY p.start_date DESC,p.sort_order DESC LIMIT 1) AS "previousId"
    FROM employment_timeline t WHERE t.tenant_id=${ctx.tenantId} AND t.record_id=${target.businessId}::uuid`),
  );
  const previousId = materialized
    ? materialized.previousId
    : (await employmentTimelineNeighbors(tx, ctx, target.employeeId, target.effectiveDate, target.businessId)).previous
        ?.recordId;
  const source = previousId ? await loadEmploymentRecord(tx, ctx.tenantId, previousId, target.effectiveDate) : null;
  await carryEstablishment(
    tx,
    ctx,
    target.businessId,
    target.effectiveDate,
    source?.fields ?? {},
    target.fields ?? {},
    warnings,
  );
}

/** 回退/改配后，原调入方仍按区间复查；沿用交互确认、后台豁免与 DEC-015 行级警告。 */
export async function assertReleasedEstablishment(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  employeeId: string,
  allocations: readonly Allocation[],
  warnings?: EstablishmentWarning[],
) {
  const { assertEstablishmentCapacity } = await import('../employment/activation-checks.js');
  const { auditEmployment } = await import('../employment/context.js');
  const { ESTABLISHMENT_REVERSAL_AUDIT } = await import('./restored-occupancy.js');
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const exceeded: Record<string, unknown>[] = [];
  for (const row of allocations.filter((row) => row.localDelta > 0 || row.inclusiveDelta > 0)) {
    const capacity = await readCapacity(tx, ctx.tenantId, row.capacityId, today);
    if (capacity.periodEnd < today) continue;
    const effectiveDate = capacity.periodStart > today ? capacity.periodStart : today;
    // 只回退这一周期的额度，不把其他周期既有超编归到本次命令。
    const until = new Date(Date.parse(capacity.periodEnd) + 86400000).toISOString().slice(0, 10);
    const assessment = await assertEstablishmentCapacity(
      tx,
      ctx,
      {
        businessId,
        employeeId,
        kind: 'transfer',
        effectiveDate,
        until,
        departmentId: capacity.orgId,
        positionId: row.positionId,
        occupancyOnly: true,
      },
      warnings,
    );
    if (assessment.exceeded)
      exceeded.push({
        departmentId: capacity.orgId,
        positionId: row.positionId,
        from: effectiveDate,
        until,
        strictControl: assessment.strict,
      });
  }
  // 放行（确认 / 服务端间接触发 / 批量警告）的携编回退超编同样留审计，与普通回退同一动作与裁剪规则（DEC-258 / 273）。
  if (!exceeded.length) return;
  await auditEmployment(tx, ctx, ESTABLISHMENT_REVERSAL_AUDIT, 'employment-business', businessId, null, {
    reason: 'ESTABLISHMENT_EXCEEDED',
    action: 'carried-release',
    origin: ctx.establishmentReversalOrigin ?? 'explicit',
    confirmed: ctx.establishmentConfirmed === true,
    strictControl: exceeded.some((item) => item.strictControl === true),
    segments: exceeded,
  });
}
