/**
 * 待入职阶段的“是否有试用期”（F-188，DEC-546② R2e8；表 employment_pending_entry_probation）：
 * 跟随待入职记录保存，办理入职时才决定人员状态（employee-status.ts）。改期 / 编辑换日期会替换记录（任职记录不可原地改日期），
 * 所以值要在同事务内搬到新记录；办理入职、删除后清除。没填过 = 没有行 = 读出 null（DEC-402 不回填存量）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { normalizeProbationInfo, type ProbationInfo } from '@italent/domain';
import { AppError } from '../../errors.js';
import { auditEmployment } from './context.js';
import { ENTRY_KINDS, type EntryOptions } from './employee-status.js';
import { rowsOf } from './record-store.js';
import type { BusinessKind, EmploymentContext } from './types.js';

export async function savePendingProbation(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  businessId: string,
  probation: boolean,
): Promise<void> {
  await tx.execute(sql`INSERT INTO employment_pending_entry_probation(tenant_id, employee_id, business_id,
      probation, updated_at)
    VALUES (${ctx.tenantId}, ${employeeId}::uuid, ${businessId}::uuid, ${probation},
      ${ctx.now.toISOString()}::timestamptz)
    ON CONFLICT (tenant_id, business_id) DO UPDATE SET probation=EXCLUDED.probation, updated_at=EXCLUDED.updated_at`);
}

export async function loadPendingProbation(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
): Promise<boolean | null> {
  const [row] = rowsOf<{ probation: boolean }>(
    await tx.execute(sql`SELECT probation FROM employment_pending_entry_probation
      WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid`),
  );
  return row ? row.probation : null;
}

export async function clearPendingProbation(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM employment_pending_entry_probation
    WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid`);
}

/** 添加待入职（pendingEntry）时随请求带来的试用期落库；返回实际保存的值（没带 / 不是待入职返回 undefined）。 */
export async function saveAddedProbation(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  businessId: string,
  kind: BusinessKind,
  entry: EntryOptions | undefined,
): Promise<boolean | undefined> {
  const probation = entry?.pendingEntry && ENTRY_KINDS.includes(kind) ? entry.probation : undefined;
  if (probation !== undefined) await savePendingProbation(tx, ctx, employeeId, businessId, probation);
  return probation;
}

/** 创建审计 after 里的试用期键：没保存过就不出现。 */
export const probationAudit = (probation: boolean | undefined) => (probation === undefined ? {} : { probation });

/**
 * 任职上的试用期信息（R2 BE-3；29 §1，15 §5）：只追加的版本链 employment_probation_versions，键 = 开启本段试用的
 * 入职 / 实习转正业务（任职记录与业务同一 ID）。入职（直接入职、办理入职；BE-6a 的实习转正同走 createEmploymentBusiness）
 * 写第 1 版，调整试用信息追加新版本；读取取最新一版。没有版本 = 入职时没填（DEC-402 不回填）。
 */
export interface ProbationVersion extends ProbationInfo {
  readonly id: string;
  readonly businessId: string;
  readonly versionNo: number;
}

export async function loadProbationVersion(
  tx: Tx,
  tenantId: string,
  businessId: string,
): Promise<ProbationVersion | null> {
  const [row] = rowsOf<ProbationVersion>(
    await tx.execute(sql`SELECT id, business_id AS "businessId", version_no AS "versionNo",
        has_probation AS "hasProbation", start_date::text AS "startDate", months,
        expected_end_date::text AS "expectedEndDate"
      FROM employment_probation_versions WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid
      ORDER BY version_no DESC LIMIT 1`),
  );
  return row ?? null;
}

/** 追加一版试用期信息并写字段级审计（DEC-019）；调用方已持该员工锁。 */
export async function appendProbationVersion(
  tx: Tx,
  ctx: EmploymentContext,
  target: { readonly employeeId: string; readonly businessId: string },
  info: ProbationInfo,
  source: 'entry' | 'adjust',
): Promise<ProbationVersion> {
  const normalized = normalizeProbationInfo(info);
  if (normalized.startDate && normalized.expectedEndDate && normalized.expectedEndDate < normalized.startDate)
    throw new AppError('VALIDATION_FAILED', '预计试用结束日期不能早于试用开始日期', {
      reason: 'PROBATION_END_BEFORE_START',
    });
  const previous = await loadProbationVersion(tx, ctx.tenantId, target.businessId);
  const saved: ProbationVersion = {
    ...normalized,
    id: randomUUID(),
    businessId: target.businessId,
    versionNo: (previous?.versionNo ?? 0) + 1,
  };
  await tx.execute(sql`INSERT INTO employment_probation_versions(id, tenant_id, employee_id, business_id, version_no,
      previous_version_id, has_probation, start_date, months, expected_end_date, source, command_id, created_at)
    VALUES (${saved.id}::uuid, ${ctx.tenantId}, ${target.employeeId}::uuid, ${target.businessId}::uuid,
      ${saved.versionNo}, ${previous?.id ?? null}::uuid, ${saved.hasProbation}, ${saved.startDate}::date,
      ${saved.months}, ${saved.expectedEndDate}::date, ${source}, ${ctx.commandId},
      ${ctx.now.toISOString()}::timestamptz)`);
  const audit = (value: ProbationInfo | null) =>
    value && {
      hasProbation: value.hasProbation,
      probationStartDate: value.startDate,
      probationMonths: value.months,
      probationEndDate: value.expectedEndDate,
    };
  await auditEmployment(
    tx,
    ctx,
    `employment.probation.${source}`,
    'employment-business',
    target.businessId,
    audit(previous),
    audit(saved),
  );
  return saved;
}

/**
 * 入职时的试用期：开始日 = 入职日 / 转正日（R2e6、R2f1）；没带是否有试用期、或添加待入职（F-188 另存）时不写。
 * deferStart = 入职申请：审批期间还可能改期，开始日留空，读取时取记录实际生效日（resolveDeferredProbation）；
 * 手填的预计结束日此时按申请上的入职日校验（不早于它）。
 */
export async function saveEntryProbation(
  tx: Tx,
  ctx: EmploymentContext,
  target: {
    readonly employeeId: string;
    readonly businessId: string;
    readonly effectiveDate: string;
    readonly deferStart?: boolean;
  },
  entry: EntryOptions | undefined,
): Promise<void> {
  if (!entry || entry.pendingEntry || entry.probation === undefined) return;
  if (entry.probation && entry.probationEndDate !== undefined && entry.probationEndDate < target.effectiveDate)
    throw new AppError('VALIDATION_FAILED', '预计试用结束日期不能早于试用开始日期', {
      reason: 'PROBATION_END_BEFORE_START',
    });
  await appendProbationVersion(
    tx,
    ctx,
    target,
    {
      hasProbation: entry.probation,
      startDate: entry.probation && !target.deferStart ? target.effectiveDate : null,
      months: entry.probationMonths ?? null,
      expectedEndDate: entry.probationEndDate ?? null,
    },
    'entry',
  );
}
