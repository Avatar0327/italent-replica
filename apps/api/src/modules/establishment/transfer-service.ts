import { randomUUID } from 'node:crypto';
import {
  and,
  desc,
  eq,
  establishmentMovementObjects,
  establishmentMovementVersions,
  sql,
  type Db,
  type Tx,
} from '@italent/db';
import { isEffectiveDue, type OrgId } from '@italent/domain';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import { capacityFor, readCapacity, type CapacityRecord } from './capacity-read.js';
import { assertOrg, createTxOrgHierarchyReader, subtreeIds } from './org-reader.js';
import { unavailablePersonnel, type EstablishmentPersonnelPort, type VerifiedTransfer } from './personnel.js';
import { loadScheme, type SchemeRecord } from './schemes.js';
import { readSettings } from './settings.js';
import {
  assertRevision,
  audit,
  businessDate,
  lockEstablishment,
  nonnegative,
  notify,
  rowsOf,
  today,
  type EstablishmentContext,
} from './store.js';

export type TransferStage = 'submitted' | 'approved' | 'rejected' | 'withdrawn' | 'effective';
export interface TransferInput {
  readonly businessId: string;
  readonly stage: TransferStage;
  readonly confirmed?: boolean;
}
export interface MovementResult {
  readonly businessId: string;
  readonly status: TransferStage | 'failed';
  readonly revision: number;
  readonly reserveIn: boolean;
  readonly reserveOut: boolean;
  readonly attempts: number;
  readonly failureReason: string | null;
  readonly warnings: readonly { orgId: string; reason: 'ESTABLISHMENT_EXCEEDED' }[];
}

async function movement(tx: Tx, tenantId: string, businessId: string) {
  const [row] = await tx
    .select({ object: establishmentMovementObjects, version: establishmentMovementVersions })
    .from(establishmentMovementObjects)
    .innerJoin(
      establishmentMovementVersions,
      and(
        eq(establishmentMovementVersions.tenantId, establishmentMovementObjects.tenantId),
        eq(establishmentMovementVersions.movementId, establishmentMovementObjects.id),
      ),
    )
    .where(
      and(eq(establishmentMovementObjects.tenantId, tenantId), eq(establishmentMovementObjects.businessId, businessId)),
    )
    .orderBy(desc(establishmentMovementVersions.versionNo))
    .limit(1);
  return row;
}

async function pending(
  tx: Tx,
  ctx: EstablishmentContext,
  record: CapacityRecord,
  scheme: SchemeRecord,
  includeDescendants: boolean,
  excludeBusinessId?: string,
  positionId?: string,
  hierarchyAsOf = today(ctx),
) {
  const ids = includeDescendants ? await subtreeIds(tx, ctx.tenantId, record.orgId, hierarchyAsOf) : [record.orgId];
  const included = ids.filter((id) => !scheme.excludedOrgIds.includes(id));
  if (!included.length) return { preIncrease: 0, preDecrease: 0 };
  const result = await tx.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON(v.movement_id) v.*,o.business_id FROM establishment_movement_versions v
      JOIN establishment_movement_objects o ON o.tenant_id=v.tenant_id AND o.id=v.movement_id
      WHERE v.tenant_id=${ctx.tenantId} ORDER BY v.movement_id,v.version_no DESC
    ) SELECT COUNT(*) FILTER(WHERE reserve_in AND target_org_id=ANY(${sql`ARRAY[${sql.join(
      included.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`})
      ${positionId ? sql`AND target_position_id=${positionId}` : sql``})::int AS pre_increase,
      COUNT(*) FILTER(WHERE reserve_out AND source_org_id=ANY(${sql`ARRAY[${sql.join(
        included.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`})
      ${positionId ? sql`AND source_position_id=${positionId}` : sql``})::int AS pre_decrease
    FROM latest WHERE effective_date>=${record.periodStart} AND effective_date<=${record.periodEnd}
      ${excludeBusinessId ? sql`AND business_id<>${excludeBusinessId}` : sql``}
  `);
  const [counts] = rowsOf<{ pre_increase: number; pre_decrease: number }>(result);
  return { preIncrease: counts?.pre_increase ?? 0, preDecrease: counts?.pre_decrease ?? 0 };
}

async function countScope(
  tx: Tx,
  ctx: EstablishmentContext,
  record: CapacityRecord,
  scheme: SchemeRecord,
  port: EstablishmentPersonnelPort,
  inclusive: boolean,
  excludeBusinessId?: string,
  positionId?: string,
  hierarchyAsOf = today(ctx),
) {
  const actual = nonnegative(
    await port.headcount(tx, {
      tenantId: ctx.tenantId,
      orgId: record.orgId,
      asOf: today(ctx),
      includeDescendants: inclusive,
      excludedOrgIds: scheme.excludedOrgIds,
      occupancyRanges: scheme.occupancyRanges,
      ...(positionId ? { positionId } : {}),
    }),
    'actual',
  );
  return {
    actual,
    ...(await pending(tx, ctx, record, scheme, inclusive, excludeBusinessId, positionId, hierarchyAsOf)),
  };
}

export async function readEstablishmentStats(
  tx: Tx,
  ctx: EstablishmentContext,
  input: { orgId: string; schemeId: string; periodStart: string },
  port: EstablishmentPersonnelPort = unavailablePersonnel,
) {
  const record = await capacityFor(
    tx,
    ctx.tenantId,
    input.orgId,
    input.schemeId,
    businessDate(input.periodStart, 'periodStart'),
    today(ctx),
  );
  if (!record) throw new AppError('NOT_FOUND', '该周期没有组织编制');
  const scheme = await loadScheme(tx, ctx.tenantId, input.schemeId, today(ctx));
  const local = await countScope(tx, ctx, record, scheme, port, false);
  const inclusive = await countScope(tx, ctx, record, scheme, port, true);
  return {
    local: {
      capacity: record.localCapacity,
      ...local,
      vacancy:
        record.localCapacity == null
          ? null
          : record.localCapacity - local.actual - local.preIncrease + local.preDecrease,
    },
    inclusive: {
      capacity: record.inclusiveCapacity,
      ...inclusive,
      vacancy:
        record.inclusiveCapacity == null
          ? null
          : record.inclusiveCapacity - inclusive.actual - inclusive.preIncrease + inclusive.preDecrease,
    },
    strictControl: record.strictControl,
  };
}

async function targetCapacities(
  tx: Tx,
  ctx: EstablishmentContext,
  transfer: VerifiedTransfer,
  asOf: string,
): Promise<CapacityRecord[]> {
  // 只读取目标行政链中的周期对象，不把全租户方案或编制对象装入内存。
  const result = await tx.execute(sql`
    WITH RECURSIVE versions AS (
      SELECT DISTINCT ON(org_id) id,org_id,stop_date FROM org_versions
      WHERE tenant_id=${ctx.tenantId} AND start_date<=${asOf}
      ORDER BY org_id,start_date DESC,version_no DESC
    ), ancestors AS (
      SELECT org_id,ARRAY[org_id]::uuid[] path FROM versions
      WHERE org_id=${transfer.targetOrgId} AND stop_date>=${asOf}
      UNION ALL
      SELECT p.org_id,a.path||p.org_id FROM ancestors a
      JOIN versions v ON v.org_id=a.org_id
      JOIN org_hierarchy_links l ON l.tenant_id=${ctx.tenantId} AND l.version_id=v.id AND l.dimension='admin'
      JOIN versions p ON p.org_id=l.parent_org_id AND p.stop_date>=${asOf}
      WHERE NOT p.org_id=ANY(a.path)
    ) SELECT DISTINCT o.id FROM establishment_objects o JOIN ancestors a ON a.org_id=o.org_id
      WHERE o.tenant_id=${ctx.tenantId} AND o.period_start<=${transfer.effectiveDate}
        AND o.period_end>=${transfer.effectiveDate} ORDER BY o.id LIMIT 10001
  `);
  const rows = rowsOf<{ id: string }>(result);
  if (rows.length > 10000) throw new AppError('SERVICE_UNAVAILABLE', '目标行政链编制超过单次处理预算');
  const records: CapacityRecord[] = [];
  for (const row of rows) {
    try {
      const record = await readCapacity(tx, ctx.tenantId, row.id, asOf);
      const scheme = await loadScheme(tx, ctx.tenantId, record.schemeId, asOf);
      if (scheme.enabled && !scheme.excludedOrgIds.includes(transfer.targetOrgId)) records.push(record);
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'NOT_FOUND')) throw error;
    }
  }
  return records;
}

async function assess(
  tx: Tx,
  ctx: EstablishmentContext,
  transfer: VerifiedTransfer,
  port: EstablishmentPersonnelPort,
  releaseSource: boolean,
  asOf = transfer.effectiveDate,
) {
  const warnings: { orgId: string; reason: 'ESTABLISHMENT_EXCEEDED' }[] = [];
  let strict = false;
  for (const record of await targetCapacities(tx, ctx, transfer, asOf)) {
    const scheme = await loadScheme(tx, ctx.tenantId, record.schemeId, asOf);
    if (scheme.occupancyRanges.length) {
      // TODO(需取证 Q-M0-15): 人事桥需提供业务对象的雇佣条件匹配，不能假定每单均占编。
      throw new AppError('SERVICE_UNAVAILABLE', '人员范围匹配接口尚未接入');
    }
    const ids = await subtreeIds(tx, ctx.tenantId, record.orgId, asOf);
    let exceeded = false;
    for (const inclusive of [false, true]) {
      const cap = inclusive ? record.inclusiveCapacity : record.localCapacity;
      if (cap == null || (!inclusive && record.orgId !== transfer.targetOrgId)) continue;
      const counts = await countScope(tx, ctx, record, scheme, port, inclusive, transfer.businessId, undefined, asOf);
      const release =
        releaseSource &&
        (inclusive
          ? ids.includes(transfer.sourceOrgId) && !scheme.excludedOrgIds.includes(transfer.sourceOrgId)
          : transfer.sourceOrgId === record.orgId);
      if (cap - counts.actual - counts.preIncrease + counts.preDecrease < 1 - Number(release)) exceeded = true;
    }
    if (scheme.subdivision === 'position') {
      const part = record.subdivisions.find((p) => p.positionId === transfer.targetPositionId);
      if (!part && scheme.unmatchedPolicy === 'reject')
        throw new AppError('CONFLICT', '未匹配细分编制，不允许调入', { reason: 'SUBDIVISION_UNMATCHED' });
      if (part) {
        for (const inclusive of [false, true]) {
          const cap = inclusive ? part.inclusiveCapacity : part.localCapacity;
          if (cap == null || (!inclusive && record.orgId !== transfer.targetOrgId)) continue;
          const counts = await countScope(
            tx,
            ctx,
            record,
            scheme,
            port,
            inclusive,
            transfer.businessId,
            part.positionId,
            asOf,
          );
          if (
            cap - counts.actual - counts.preIncrease + counts.preDecrease <
            1 -
              Number(
                releaseSource &&
                  transfer.sourcePositionId === part.positionId &&
                  !scheme.excludedOrgIds.includes(transfer.sourceOrgId) &&
                  (inclusive ? ids.includes(transfer.sourceOrgId) : transfer.sourceOrgId === record.orgId),
              )
          )
            exceeded = true;
        }
      }
    }
    if (exceeded) {
      warnings.push({ orgId: record.orgId, reason: 'ESTABLISHMENT_EXCEEDED' });
      strict ||= record.strictControl;
    }
  }
  return { warnings, strict };
}

export async function applyTransferStage(
  tx: Tx,
  ctx: EstablishmentContext,
  input: TransferInput,
  port: EstablishmentPersonnelPort = unavailablePersonnel,
  options: { batch?: boolean } = {},
): Promise<MovementResult> {
  await lockEstablishment(tx, ctx);
  const previous = await movement(tx, ctx.tenantId, input.businessId);
  assertRevision(ctx.expectedRevision, previous?.object.revision ?? 0);
  if (previous?.version.status === input.stage)
    return { businessId: input.businessId, ...previous.version, revision: previous.object.revision, warnings: [] };
  if (!previous && input.stage !== 'submitted') throw new AppError('CONFLICT', '调动必须先提交');
  if (previous && ['effective', 'rejected', 'withdrawn'].includes(previous.version.status))
    throw new AppError('CONFLICT', '调动已经结束');
  if (input.stage === 'effective' && !['approved', 'failed'].includes(previous?.version.status ?? ''))
    throw new AppError('CONFLICT', '调动尚未审批通过');
  if (input.stage === 'submitted' && previous) throw new AppError('CONFLICT', '调动不能退回提交阶段');
  if (previous && (input.stage === 'rejected' || input.stage === 'withdrawn')) {
    // 已验证的占编事实足以释放预占；组织停用或人事桥暂不可用不能阻止撤销。
    return persistMovement(tx, ctx, input.businessId, { ...previous.version, businessId: input.businessId }, previous, {
      status: input.stage,
      reserveIn: false,
      reserveOut: false,
      attempts: previous.version.attempts,
      failureReason: null,
      warnings: [],
    });
  }
  const transfer = await port.readTransfer(tx, { tenantId: ctx.tenantId, businessId: input.businessId });
  if (transfer.businessId !== input.businessId) throw new AppError('CONFLICT', '可信业务单标识不一致');
  businessDate(transfer.effectiveDate);
  if (transfer.withEstablishment) {
    // TODO(需取证 Q-M0-18): 18§6 未定义带编转移数量/细分分配，不能猜测容量增减。
    throw new AppError('SERVICE_UNAVAILABLE', '带编调动分配规则尚待取证');
  }
  if (input.stage === 'effective') return applyEffective(tx, ctx, transfer, previous, port);
  await assertOrg(tx, ctx.tenantId, transfer.sourceOrgId, transfer.effectiveDate);
  await assertOrg(tx, ctx.tenantId, transfer.targetOrgId, transfer.effectiveDate);
  const timings = await readSettings(tx, ctx.tenantId, today(ctx));
  const reserveIn = timings.transferIn === 'submitted' || input.stage === 'approved';
  const reserveOut = timings.transferOut === 'submitted' || input.stage === 'approved';
  const assessment =
    reserveIn || options.batch ? await assess(tx, ctx, transfer, port, reserveOut) : { warnings: [], strict: false };
  if (assessment.warnings.length && !options.batch) {
    if (assessment.strict)
      throw new AppError('CONFLICT', '已超出设定编制，不可继续操作', {
        reason: 'ESTABLISHMENT_EXCEEDED',
        warnings: assessment.warnings,
      });
    if (!input.confirmed)
      throw new AppError('CONFLICT', '请确认超编信息', {
        reason: 'CONFIRMATION_REQUIRED',
        warnings: assessment.warnings,
      });
  }
  return persistMovement(tx, ctx, input.businessId, transfer, previous, {
    status: input.stage,
    reserveIn,
    reserveOut,
    attempts: previous?.version.attempts ?? 0,
    failureReason: null,
    warnings: assessment.warnings,
  });
}

async function applyEffective(
  tx: Tx,
  ctx: EstablishmentContext,
  transfer: VerifiedTransfer,
  previous: Awaited<ReturnType<typeof movement>>,
  port: EstablishmentPersonnelPort,
): Promise<MovementResult> {
  if (!isEffectiveDue(transfer.effectiveDate, ctx.timezone, ctx.now))
    throw new AppError('CONFLICT', '调动尚未到租户生效日', { reason: 'NOT_EFFECTIVE_DUE' });
  const asOf = today(ctx);
  const reader = createTxOrgHierarchyReader(tx);
  let failureReason: string | null = null;
  if (!(await reader.isEnabled({ tenantId: ctx.tenantId, orgId: transfer.targetOrgId as OrgId, asOf })))
    failureReason = 'TARGET_ORG_DISABLED';
  else if (!(await reader.isEnabled({ tenantId: ctx.tenantId, orgId: transfer.sourceOrgId as OrgId, asOf })))
    failureReason = 'SOURCE_ORG_DISABLED';
  const assessment = failureReason
    ? { strict: false, warnings: [] }
    : await assess(tx, ctx, transfer, port, true, asOf);
  if (assessment.strict && assessment.warnings.length) failureReason = 'ESTABLISHMENT_EXCEEDED';
  if (!failureReason)
    await port.applyTransfer(tx, {
      tenantId: ctx.tenantId,
      businessId: transfer.businessId,
      commandId: ctx.commandId,
      asOf,
    });
  return persistMovement(tx, ctx, transfer.businessId, transfer, previous, {
    status: failureReason ? 'failed' : 'effective',
    reserveIn: false,
    reserveOut: false,
    attempts: (previous?.version.attempts ?? 0) + 1,
    failureReason,
    warnings: assessment.warnings,
  });
}

async function persistMovement(
  tx: Tx,
  ctx: EstablishmentContext,
  businessId: string,
  transfer: VerifiedTransfer,
  previous: Awaited<ReturnType<typeof movement>>,
  data: Omit<MovementResult, 'businessId' | 'revision'>,
): Promise<MovementResult> {
  const { status, reserveIn, reserveOut, attempts, failureReason, warnings } = data;
  const id = previous?.object.id ?? randomUUID();
  const revision = (previous?.object.revision ?? 0) + 1;
  if (!previous)
    await tx
      .insert(establishmentMovementObjects)
      .values({ id, tenantId: ctx.tenantId, businessId, revision, createdAt: ctx.now });
  else
    await tx
      .update(establishmentMovementObjects)
      .set({ revision })
      .where(and(eq(establishmentMovementObjects.tenantId, ctx.tenantId), eq(establishmentMovementObjects.id, id)));
  const [saved] = await tx
    .insert(establishmentMovementVersions)
    .values({
      tenantId: ctx.tenantId,
      movementId: id,
      versionNo: revision,
      previousVersionId: previous?.version.id ?? null,
      employeeId: transfer.employeeId,
      sourceOrgId: transfer.sourceOrgId,
      targetOrgId: transfer.targetOrgId,
      sourcePositionId: transfer.sourcePositionId ?? null,
      targetPositionId: transfer.targetPositionId ?? null,
      effectiveDate: transfer.effectiveDate,
      status,
      reserveIn: status === 'failed' ? (previous?.version.reserveIn ?? false) : reserveIn,
      reserveOut: status === 'failed' ? (previous?.version.reserveOut ?? false) : reserveOut,
      attempts,
      failureReason,
      createdAt: ctx.now,
    })
    .returning();
  if (!saved) throw new AppError('SERVICE_UNAVAILABLE', '无法记录调动占编');
  const result: MovementResult = {
    businessId,
    status,
    revision,
    reserveIn: saved.reserveIn,
    reserveOut: saved.reserveOut,
    attempts,
    failureReason,
    warnings,
  };
  await audit(
    tx,
    ctx,
    `establishment.transfer.${status}`,
    'establishment-movement',
    id,
    previous?.version ?? null,
    result,
  );
  if (status === 'failed') await notify(tx, ctx, failureReason!, { movementId: id, attempt: attempts });
  return result;
}

export async function applyBatchTransfers(
  tx: Tx,
  ctx: EstablishmentContext,
  input: { businessIds: readonly string[]; stage: TransferStage; confirmed?: boolean },
  port: EstablishmentPersonnelPort = unavailablePersonnel,
) {
  if (input.businessIds.length > 200 || new Set(input.businessIds).size !== input.businessIds.length)
    throw new AppError('VALIDATION_FAILED', '批量业务单须不重复且不超过200条');
  const items: MovementResult[] = [];
  for (const businessId of input.businessIds)
    items.push(
      await applyTransferStage(tx, ctx, { businessId, stage: input.stage, confirmed: input.confirmed }, port, {
        batch: true,
      }),
    );
  return { items };
}

/** 人事/定时工作桥：服务端来源的业务ID经过原有runCommand台账，包含失败结果与通知的原子提交。 */
export async function runTransferCommand(
  db: Db,
  ctx: EstablishmentContext & { userId: string },
  input: TransferInput,
  port: EstablishmentPersonnelPort = unavailablePersonnel,
) {
  return runCommand(db, ctx, {
    id: ctx.commandId,
    fingerprint: { action: 'establishment.transfer', expectedRevision: ctx.expectedRevision, input },
    execute: async (tx, commandId) => ({
      status: 200,
      body: await applyTransferStage(tx, { ...ctx, commandId }, input, port),
    }),
  });
}

export async function runBatchTransferCommand(
  db: Db,
  ctx: EstablishmentContext & { userId: string },
  input: { businessIds: readonly string[]; stage: TransferStage; confirmed?: boolean },
  port: EstablishmentPersonnelPort = unavailablePersonnel,
) {
  return runCommand(db, ctx, {
    id: ctx.commandId,
    fingerprint: { action: 'establishment.transfer.batch', expectedRevision: ctx.expectedRevision, input },
    execute: async (tx, commandId) => ({
      status: 200,
      body: await applyBatchTransfers(tx, { ...ctx, commandId }, input, port),
    }),
  });
}
