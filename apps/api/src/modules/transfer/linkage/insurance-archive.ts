/**
 * 调动联动的社保档案子项（F-474-8c-2c；设计 F-474-8b §3.3 / §4.2）：生效日在联动子项自己的保存点里追加一条
 * 社保档案版本。只存本单填写的三项（未填的读取时折叠继承）；业务先后只用（生效日、计划生效日、操作先后）三元组，
 * 与读侧 archive-fold.ts 同一来源。幂等键 = 租户 + 'transfer' + 业务编号（唯一约束兜底）。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../../errors.js';
import { auditEmployment } from '../../employment/context.js';
import { rowsOf } from '../../employment/record-store.js';
import type { EmploymentContext } from '../../employment/types.js';
import { insurancePosition, LATEST_SEQ } from '../../insurance/archive-fold.js';
import type { LinkageOptions } from './input.js';
import { latestLinkage } from './store.js';
import type { LinkageItemRow } from './items.js';

export interface InsuranceAdjust {
  readonly regionCode: string | null;
  readonly planId: string | null;
  readonly companyId: string | null;
}

export const insuranceAdjustOf = (options: LinkageOptions): InsuranceAdjust => ({
  regionCode: options.adjustedInsuranceRegionCode ?? null,
  planId: options.adjustedInsurancePlanId ?? null,
  companyId: options.adjustedInsuranceCompanyId ?? null,
});

const invalid = (message: string, reason: string) => new AppError('VALIDATION_FAILED', message, { reason });
const monthOf = (date: string) => `${date.slice(0, 7)}-01`;

/**
 * 保存与生效两处共用的候选校验：缴交地须是字典内编码；方案须在生效日当月有效且启用（与候选接口同一判定）；
 * 公司须是本租户启用的合同公司。别的租户的方案 / 公司与不存在同形（RLS + 租户谓词），不泄露存在性。
 */
export async function validateInsuranceAdjust(
  tx: Tx,
  tenantId: string,
  adjust: InsuranceAdjust,
  effectiveDate: string,
): Promise<void> {
  if (adjust.regionCode) {
    const [known] = rowsOf(await tx.execute(sql`SELECT 1 FROM admin_regions WHERE code = ${adjust.regionCode}`));
    if (!known) throw invalid('缴交地不在行政区划字典内', 'INSURANCE_REGION_INVALID');
  }
  if (adjust.planId) {
    const month = monthOf(effectiveDate);
    const [plan] = rowsOf(
      await tx.execute(sql`SELECT 1 FROM social_insurance_plan_versions
        WHERE tenant_id = ${tenantId} AND plan_id = ${adjust.planId}::uuid AND enabled
          AND effective_month <= ${month}::date AND (stop_month IS NULL OR stop_month > ${month}::date) LIMIT 1`),
    );
    if (!plan) throw invalid('社保方案在生效日当月不可用', 'INSURANCE_PLAN_INVALID');
  }
  if (adjust.companyId) {
    const [company] = rowsOf(
      await tx.execute(sql`SELECT 1 FROM contract_companies
        WHERE tenant_id = ${tenantId} AND id = ${adjust.companyId}::uuid AND enabled`),
    );
    if (!company) throw invalid('社保缴纳公司不可用', 'INSURANCE_COMPANY_INVALID');
  }
}

interface ArchiveRow {
  versionNo: number;
  regionCode: string | null;
  planId: string | null;
  companyId: string | null;
}

/**
 * 执行 insurance_archive 子项（在子项保存点内调用，业务拒绝抛出由 attemptLinkageItem 记为该子项失败）。
 * 已有同来源事件：值相同视为幂等命中（不新增版本、不重复审计），值不同是冲突，不覆盖。
 */
export async function appendInsuranceArchive(tx: Tx, ctx: EmploymentContext, item: LinkageItemRow): Promise<void> {
  const stored = await latestLinkage(tx, ctx.tenantId, item.businessId);
  const adjust = stored && insuranceAdjustOf(stored.options);
  if (!adjust || !(adjust.regionCode || adjust.planId || adjust.companyId)) return;
  // version_no = max+1 在员工锁下分配；各入口已持锁时这里是重入，不新增锁序。
  await tx.execute(sql`SELECT 1 FROM employment_employees
    WHERE tenant_id = ${ctx.tenantId} AND id = ${item.employeeId}::uuid FOR NO KEY UPDATE`);
  const [existing] = rowsOf<ArchiveRow>(
    await tx.execute(sql`SELECT version_no AS "versionNo", region_code AS "regionCode", plan_id AS "planId",
        company_id AS "companyId"
      FROM social_insurance_archive_versions
      WHERE tenant_id = ${ctx.tenantId} AND source = 'transfer' AND source_business_id = ${item.businessId}::uuid`),
  );
  if (existing) {
    if (
      existing.regionCode === adjust.regionCode &&
      existing.planId === adjust.planId &&
      existing.companyId === adjust.companyId
    )
      return;
    throw new AppError('CONFLICT', '该调动已写入社保档案，且与当前调整值不一致', {
      reason: 'INSURANCE_ARCHIVE_CONFLICT',
    });
  }
  const position = await insurancePosition(tx, ctx.tenantId, item.employeeId, item.effectiveDate, item.businessId);
  // 业务还没写状态事件（正在落地的直接业务）：位置不确定，不落在“最晚”，记为可重试的失败。
  if (position.operationSeq === LATEST_SEQ)
    throw new AppError('CONFLICT', '调动的操作先后尚未确定，稍后重试', { reason: 'INSURANCE_OPERATION_PENDING' });
  await validateInsuranceAdjust(tx, ctx.tenantId, adjust, position.effectiveDate);
  const [row] = rowsOf<{ versionNo: number }>(
    await tx.execute(sql`INSERT INTO social_insurance_archive_versions
        (tenant_id, employee_id, version_no, effective_date, planned_effective_date, operation_seq,
         region_code, plan_id, company_id, source, source_business_id, command_id, created_at)
      SELECT ${ctx.tenantId}, ${item.employeeId}::uuid, COALESCE(max(version_no), 0) + 1,
        ${position.effectiveDate}::date, ${position.plannedDate}::date, ${position.operationSeq}::bigint,
        ${adjust.regionCode}, ${adjust.planId}::uuid, ${adjust.companyId}::uuid, 'transfer',
        ${item.businessId}::uuid, ${ctx.commandId}, ${ctx.now.toISOString()}::timestamptz
      FROM social_insurance_archive_versions
      WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${item.employeeId}::uuid
      RETURNING version_no AS "versionNo"`),
  );
  await auditEmployment(tx, ctx, 'insurance.archive.append', 'insurance-archive', item.businessId, null, {
    versionNo: row!.versionNo,
    effectiveDate: position.effectiveDate,
    plannedEffectiveDate: position.plannedDate,
    source: 'transfer',
    ...adjust,
  });
}
