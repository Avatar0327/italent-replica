/**
 * 待入职劳动合同（F-194，DEC-550 R2e9 §5 / §7.5；表 employment_pending_entry_contract）：
 * 待入职阶段挂在待入职记录上的“临时合同”，不是合同模块的正式合同（不进 contracts 表、不在合同列表）。
 * 进入待入职时生成（起始日 = 计划入职日期，终止日为空）；改期入职同步起始日并给提示，行内编辑不动它；
 * 改期 / 编辑换日期会替换记录（任职记录不可原地改日期），所以合同要在同事务内搬到新记录；
 * 办理入职、删除待入职后清除。没有行 = 存量待入职（DEC-402 不回填），读出 null。
 *
 * 端口约定：Offer 同步生成待入职（BE-14）时同样调用 createEmploymentBusiness 的 pendingEntry 通道，
 * 由 saveAddedPendingContract 生成待入职合同；Offer 侧不另写一份。
 */
import { sql, type Tx } from '@italent/db';
import { auditEmployment } from './context.js';
import { ENTRY_KINDS, type EntryOptions } from './employee-status.js';
import { probationAudit, saveAddedProbation } from './entry-probation.js';
import { rowsOf } from './record-store.js';
import type { BusinessKind, EmploymentContext, NormalizedEmploymentInput } from './types.js';

export interface PendingContract {
  readonly startDate: string;
  readonly endDate: string | null;
  /** 合同公司（甲方）：Offer 同步带来；手工添加 / 存量为 null（BE-14b2，34 文末映射）。 */
  readonly companyId?: string | null;
}

/** 改期入职响应里的提示数据：前端拼出“待入职记录中劳动合同起止日期改为YYYY/MM/DD-”，止日为空时尾部留空。 */
export type PendingContractNotice = PendingContract;

export async function savePendingContract(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  businessId: string,
  contract: PendingContract,
): Promise<void> {
  await tx.execute(sql`INSERT INTO employment_pending_entry_contract(tenant_id, employee_id, business_id,
      start_date, end_date, contract_company_id, updated_at)
    VALUES (${ctx.tenantId}, ${employeeId}::uuid, ${businessId}::uuid, ${contract.startDate}::date,
      ${contract.endDate}::date, ${contract.companyId ?? null}::uuid, ${ctx.now.toISOString()}::timestamptz)
    ON CONFLICT (tenant_id, business_id) DO UPDATE SET start_date=EXCLUDED.start_date,
      end_date=EXCLUDED.end_date, contract_company_id=EXCLUDED.contract_company_id,
      updated_at=EXCLUDED.updated_at`);
}

export async function loadPendingContract(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
): Promise<PendingContract | null> {
  const [row] = rowsOf<PendingContract>(
    await tx.execute(sql`SELECT start_date::text AS "startDate", end_date::text AS "endDate",
        contract_company_id::text AS "companyId"
      FROM employment_pending_entry_contract
      WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid`),
  );
  return row ?? null;
}

export async function clearPendingContract(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM employment_pending_entry_contract
    WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid`);
}

/**
 * 办理入职 / 删除待入职时清掉待入职合同；真的有合同才写审计（前值留快照，DEC-019），存量没有合同的不产生噪声。
 * 办理入职的正式合同由 entry-contract.ts 另行生成，这里只处理待入职阶段那一份。
 */
export async function releasePendingContract(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  reason: 'complete' | 'delete',
): Promise<void> {
  const before = await loadPendingContract(tx, ctx, businessId);
  if (!before) return;
  await clearPendingContract(tx, ctx, businessId);
  await auditEmployment(
    tx,
    ctx,
    'employment.entry.contract_release',
    'employment-business',
    businessId,
    pendingContractAudit(before),
    null,
    undefined,
    { reason },
  );
}

/** 添加待入职（pendingEntry）时生成待入职合同；返回实际保存的合同（不是待入职 / 显式不生成返回 undefined）。 */
export async function saveAddedPendingContract(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  businessId: string,
  kind: BusinessKind,
  effectiveDate: string,
  entry: EntryOptions | undefined,
): Promise<PendingContract | undefined> {
  if (!entry?.pendingEntry || !ENTRY_KINDS.includes(kind)) return undefined;
  // 缺省 = 新生成（起始日取计划入职日期、终止日为空）；null = 替换记录时原记录本来就没有合同（存量），不补生成
  const contract =
    entry.pendingContract === undefined
      ? { startDate: effectiveDate, endDate: null, companyId: null }
      : entry.pendingContract;
  if (contract === null) return undefined;
  await savePendingContract(tx, ctx, employeeId, businessId, contract);
  return contract;
}

/** 审计里的合同起止日键；没有合同时两个键都是 null（字段级前后值）。 */
export const pendingContractAudit = (contract: PendingContract | null | undefined) => ({
  contractStartDate: contract?.startDate ?? null,
  contractEndDate: contract?.endDate ?? null,
  // 合同公司只在有值时出现：手工添加的待入职审计形状不变
  ...(contract?.companyId ? { contractCompanyId: contract.companyId } : {}),
});

/**
 * 添加待入职时随记录落库的待入职数据（试用期 F-188 + 合同 F-194），返回并入创建审计 after 的字段级键
 * （没保存过的键不出现）。从 createEmploymentBusiness 抽出，保持那里的函数长度。
 */
export async function saveAddedPendingEntryData(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  businessId: string,
  input: Pick<NormalizedEmploymentInput, 'kind' | 'effectiveDate'>,
  entry: EntryOptions | undefined,
): Promise<Record<string, unknown>> {
  const { kind, effectiveDate } = input;
  const probation = await saveAddedProbation(tx, ctx, employeeId, businessId, kind, entry);
  const contract = await saveAddedPendingContract(tx, ctx, employeeId, businessId, kind, effectiveDate, entry);
  return { ...probationAudit(probation), ...(contract ? pendingContractAudit(contract) : {}) };
}
