import { and, eq, establishmentObjects, inArray, sql, transferEstablishmentAllocations, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { employmentCapacityContext } from '../permission/module-capacity-authorization.js';
import type { EmploymentContext, PresetFields } from '../employment/types.js';
import { validateCapacity } from './constraints.js';
import { employmentTimelineNeighbors } from '../employment/timeline.js';
import { loadEmploymentRecord } from '../employment/read-model.js';
import type { ActivationTarget } from '../employment/activation-checks.js';
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
  // 编辑 / 重提 / 迟到跨周期复查：旧分配的回退与新分配的调编是同一个净变化单元（F-400 r4，DEC-431①），
  // 每个编制对象只写一次最终值；分两段写时，回退旧分配的中间值可能越过整数上限或细分下限，而最终状态合法。
  await authorizeAllocationCapacities(tx, ctx, context, existing);
  const changes = [
    ...existing.map((row) => ({ businessId, action: 'reverse' as const, change: reversal(row) })),
    ...deltas.map((change) => ({ businessId, action: 'adjust' as const, change })),
  ];
  for (const items of byCapacity(changes)) await applyCapacityNet(tx, context, items, today);
  await markReversed(tx, ctx.tenantId, existing);
  for (const change of deltas)
    await tx
      .insert(transferEstablishmentAllocations)
      .values({ ...change, tenantId: ctx.tenantId, businessId, createdAt: ctx.now });
  for (const id of new Set([...existing, ...deltas].map((change) => change.capacityId)))
    await validateCapacity(tx, context, await readCapacity(tx, ctx.tenantId, id, today));
  if (existing.length) {
    const [business] = rowsOf<{ employeeId: string }>(
      await tx.execute(sql`
      SELECT employee_id AS "employeeId" FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${businessId}::uuid`),
    );
    if (business) await assertReleasedEstablishment(tx, ctx, businessId, business.employeeId, existing);
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

/** 一条带编增减：属于哪个业务、按调编（adjust）还是回退（reverse）记审计。 */
interface CarriedChange {
  readonly businessId: string;
  readonly action: 'adjust' | 'reverse';
  readonly change: Delta;
}

type Amounts = Pick<Delta, 'localDelta' | 'inclusiveDelta' | 'reservedLocalDelta' | 'reservedInclusiveDelta'>;

const reversal = (row: Delta): Delta => ({
  capacityId: row.capacityId,
  positionId: row.positionId,
  localDelta: -row.localDelta,
  inclusiveDelta: -row.inclusiveDelta,
  reservedLocalDelta: -row.reservedLocalDelta,
  reservedInclusiveDelta: -row.reservedInclusiveDelta,
});

const sum = (changes: readonly Amounts[]): Amounts =>
  changes.reduce(
    (n, c) => ({
      localDelta: n.localDelta + c.localDelta,
      inclusiveDelta: n.inclusiveDelta + c.inclusiveDelta,
      reservedLocalDelta: n.reservedLocalDelta + c.reservedLocalDelta,
      reservedInclusiveDelta: n.reservedInclusiveDelta + c.reservedInclusiveDelta,
    }),
    { localDelta: 0, inclusiveDelta: 0, reservedLocalDelta: 0, reservedInclusiveDelta: 0 },
  );

/**
 * 带编额度写入的单一口径（F-400 r4，DEC-431①）：调编、单笔回退、整组回退、编辑时的“回退旧分配 + 调编新分配”都先经
 * byCapacity 按编制对象分组，再对每组调一次 applyCapacityNet。
 * 不变式：同一次写入的全部增减按编制对象（及其职位细分、预留）汇总成净变化，每个编制对象只读一次、只写一次最终值，
 * 预留 / 细分 / 总额的非负与整数上限（normalize）只对最终值判断。因此结果与业务 ID 顺序、与“在途组 / 已落地组”分组、
 * 与上下限附近的中间值都无关；最终值不合法时照常报错，由调用方整单回滚。编制对象按 ID 升序写入，只为顺序确定。
 * 调用层级与第 3 轮的逐条 applyDelta 相同（调用方 → applyCapacityNet → updateCapacity / audit），F-039 近闭包不变弱。
 */
function byCapacity(changes: readonly CarriedChange[]): CarriedChange[][] {
  const groups = new Map<string, CarriedChange[]>();
  for (const item of changes) groups.set(item.change.capacityId, [...(groups.get(item.change.capacityId) ?? []), item]);
  return [...groups.keys()].sort().map((id) => groups.get(id)!);
}

async function applyCapacityNet(tx: Tx, ctx: EstablishmentContext, items: readonly CarriedChange[], date: string) {
  const before = await readCapacity(tx, ctx.tenantId, items[0]!.change.capacityId, date);
  const scheme = await loadScheme(tx, ctx.tenantId, before.schemeId, date);
  const net = sum(items.map((item) => item.change));
  const reservedLocal = before.reservedLocal + net.reservedLocalDelta;
  const reservedInclusive = before.reservedInclusive + net.reservedInclusiveDelta;
  if (reservedLocal < 0 || reservedInclusive < 0)
    throw new AppError('CONFLICT', '调出部门的预留编制不足', { reason: 'ESTABLISHMENT_RESERVE_INSUFFICIENT' });
  if (
    items.some(
      ({ change }) => change.positionId && !before.subdivisions.some((part) => part.positionId === change.positionId),
    )
  )
    throw new AppError('CONFLICT', '原调编细分已被删除，无法按原分配回退', {
      reason: 'ESTABLISHMENT_ALLOCATION_CHANGED',
    });
  const subdivisions = before.subdivisions.map((part) => {
    const own = items.filter(({ change }) => change.positionId === part.positionId).map(({ change }) => change);
    if (!own.length) return part;
    const d = sum(own);
    return {
      ...part,
      localCapacity: part.localCapacity === null ? null : part.localCapacity + d.localDelta,
      inclusiveCapacity: part.inclusiveCapacity === null ? null : part.inclusiveCapacity + d.inclusiveDelta,
    };
  });
  if (
    subdivisions.some((p) => (p.localCapacity ?? 0) < 0 || (p.inclusiveCapacity ?? 0) < 0) ||
    (before.localCapacity !== null && before.localCapacity + net.localDelta < 0) ||
    (scheme.maintenanceMode !== 'local' &&
      before.inclusiveCapacity !== null &&
      before.inclusiveCapacity + net.inclusiveDelta < 0)
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
            localCapacity: before.localCapacity === null ? null : before.localCapacity + net.localDelta,
            inclusiveCapacity:
              scheme.maintenanceMode === 'local' || before.inclusiveCapacity === null
                ? null
                : before.inclusiveCapacity + net.inclusiveDelta,
          }),
    },
    { deferConstraints: true },
  );
  const { action, owner, delta } = netAudit(items);
  await audit(
    tx,
    ctx,
    `establishment.transfer.${action}`,
    'establishment-capacity',
    before.id,
    { ...owner, capacity: before },
    { ...owner, capacity: after, delta },
  );
}

/**
 * 每个编制对象一条审计：只涉及一个业务时保持 businessId；整组回退跨多个业务时写 businessIds（前后相同，不产生字段差异）。
 * 只有一条增减时 delta 就是这条分配（与第 3 轮前同形）；多条时 delta 给出净额与逐条明细。delta.* 不进字段级变更投影。
 * 全是回退记 reverse，含调编（编辑时旧分配回退与新分配落在同一编制对象）记 adjust。
 */
function netAudit(items: readonly CarriedChange[]) {
  const businessIds = [...new Set(items.map((item) => item.businessId))].sort();
  return {
    action: items.every((item) => item.action === 'reverse') ? 'reverse' : 'adjust',
    owner: businessIds.length === 1 ? { businessId: businessIds[0] } : { businessIds },
    delta:
      items.length === 1
        ? items[0]!.change
        : {
            capacityId: items[0]!.change.capacityId,
            ...sum(items.map((item) => item.change)),
            allocations: items.map(({ businessId, action, change }) => ({ businessId, action, ...change })),
          },
  };
}

/** 回退按原分配授权全部对象，不能在授权另一侧前暴露任一侧的细分、预留或额度状态。 */
async function authorizeAllocationCapacities(
  tx: Tx,
  ctx: EmploymentContext,
  context: EstablishmentContext,
  allocations: readonly Allocation[],
) {
  for (const id of new Set(allocations.map((row) => row.capacityId))) {
    const [object] = await tx
      .select({ orgId: establishmentObjects.orgId })
      .from(establishmentObjects)
      .where(and(eq(establishmentObjects.tenantId, ctx.tenantId), eq(establishmentObjects.id, id)));
    if (!object) throw new AppError('NOT_FOUND', '编制在该时点不存在');
    await context.authorizeCapacityScope?.(tx, { operation: 'update', id, orgId: object.orgId });
  }
}

async function markReversed(tx: Tx, tenantId: string, allocations: readonly Allocation[]) {
  if (!allocations.length) return;
  await tx
    .update(transferEstablishmentAllocations)
    .set({ reversed: true })
    .where(
      and(
        eq(transferEstablishmentAllocations.tenantId, tenantId),
        inArray(
          transferEstablishmentAllocations.id,
          allocations.map((row) => row.id),
        ),
      ),
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
  if (!(await groupAllocations(tx, ctx.tenantId, [businessId])).length) return [];
  await lockEstablishment(tx, context, { initializeDefault: false });
  const allocations = await groupAllocations(tx, ctx.tenantId, [businessId]);
  return (await reverseAllocations(tx, ctx, context, allocations)).get(businessId) ?? [];
}

/**
 * 一组业务的带编分配整组回退（离职生效一次作废多条带编调动：在途组与已落地组合并成一组，F-400 r3 / r4）：
 * 各单之间可能首尾相接（10-20 A→B、10-21 B→A），也可能分属在途与已落地两组；逐笔或分组回退的中间状态会出现负额度、
 * 超编或越过整数上限，结果取决于处理顺序与分组。这里把整组的反向增减按编制对象分组（byCapacity）交给 applyCapacityNet，只按整组最终状态校验。
 * 最终仍不足 / 越界时照常报错，由调用方整单回滚。返回各业务被回退的原分配。
 */
export async function reverseCarriedEstablishmentGroup(tx: Tx, ctx: EmploymentContext, businessIds: readonly string[]) {
  const context = await employmentCapacityContext(tx, ctx);
  if (!(await groupAllocations(tx, ctx.tenantId, businessIds)).length) return new Map<string, Allocation[]>();
  await lockEstablishment(tx, context, { initializeDefault: false });
  const allocations = await groupAllocations(tx, ctx.tenantId, businessIds);
  return reverseAllocations(tx, ctx, context, allocations);
}

/** 单笔与整组共用：授权 → 整组净变化写入（每个编制对象一次）→ 置 reversed → 按最终状态校验；调用方已取得编制锁。 */
async function reverseAllocations(
  tx: Tx,
  ctx: EmploymentContext,
  context: EstablishmentContext,
  allocations: readonly Allocation[],
) {
  // 回退按原分配授权全部对象，不能在授权另一侧前暴露任一侧的细分、预留或额度状态（与第 3 轮同层内联，F-039 近闭包不变弱）。
  for (const id of new Set(allocations.map((row) => row.capacityId))) {
    const [object] = await tx
      .select({ orgId: establishmentObjects.orgId })
      .from(establishmentObjects)
      .where(and(eq(establishmentObjects.tenantId, ctx.tenantId), eq(establishmentObjects.id, id)));
    if (!object) throw new AppError('NOT_FOUND', '编制在该时点不存在');
    await context.authorizeCapacityScope?.(tx, { operation: 'update', id, orgId: object.orgId });
  }
  const date = tenantLocalDate(ctx.now, ctx.timezone);
  const ordered = [...allocations].sort((a, b) => a.businessId.localeCompare(b.businessId) || a.id.localeCompare(b.id));
  const changes = ordered.map((row) => ({
    businessId: row.businessId,
    action: 'reverse' as const,
    change: reversal(row),
  }));
  for (const items of byCapacity(changes)) await applyCapacityNet(tx, context, items, date);
  await markReversed(tx, ctx.tenantId, ordered);
  const released = new Map<string, Allocation[]>();
  for (const row of ordered) released.set(row.businessId, [...(released.get(row.businessId) ?? []), row]);
  for (const id of new Set(allocations.map((row) => row.capacityId)))
    await validateCapacity(tx, context, await readCapacity(tx, ctx.tenantId, id, date));
  return released;
}

async function groupAllocations(tx: Tx, tenantId: string, businessIds: readonly string[]) {
  if (!businessIds.length) return [];
  return tx
    .select()
    .from(transferEstablishmentAllocations)
    .where(
      and(
        eq(transferEstablishmentAllocations.tenantId, tenantId),
        inArray(transferEstablishmentAllocations.businessId, [...businessIds]),
        eq(transferEstablishmentAllocations.reversed, false),
      ),
    );
}

/** 编辑、重提与迟到跨周期复查使用当前任职插入点；相同分配幂等，不在到期时再次加编。 */
export async function reconcileCarriedEstablishment(tx: Tx, ctx: EmploymentContext, target: ActivationTarget) {
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
  await carryEstablishment(tx, ctx, target.businessId, target.effectiveDate, source?.fields ?? {}, target.fields ?? {});
}

/** 回退后，原调入方被其他业务占用的编制仍需严格控编；调用者已将本单置为撤销/删除。 */
export async function assertReleasedEstablishment(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  employeeId: string,
  allocations: readonly Allocation[],
) {
  const { employmentEstablishmentExceeded } = await import('./employment-check.js');
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  for (const row of allocations.filter((row) => row.localDelta > 0 || row.inclusiveDelta > 0)) {
    const capacity = await readCapacity(tx, ctx.tenantId, row.capacityId, today);
    if (capacity.periodEnd < today) continue;
    const effectiveDate = capacity.periodStart > today ? capacity.periodStart : today;
    if (
      await employmentEstablishmentExceeded(tx, ctx, {
        businessId,
        employeeId,
        kind: 'transfer',
        effectiveDate,
        departmentId: capacity.orgId,
        positionId: row.positionId,
        occupancyOnly: true,
      })
    )
      throw new AppError('CONFLICT', '回退带编调动后将超出严格控制编制', { reason: 'ESTABLISHMENT_EXCEEDED' });
  }
}
