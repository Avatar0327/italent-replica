/**
 * 社保档案原值折叠（F-474-8c-2b；设计 F-474-8b §3.3 / §4.1，AC-INS-02）。
 * 档案是事件溯源版本链：每个事件只带本次变动的值（缴交地 / 方案 / 公司，未变的为空）。
 * 某个业务位置的“原值”= 严格早于该位置的事件，按业务先后从头折叠，每个事件只覆盖它自己的非空值。
 * 业务先后只有一个口径：（生效日、计划生效日、操作先后）三元组，来自任职时间轴同一套函数
 * （employment/timeline.ts 的 operationKey / loadPlannedEffectiveDate）；version_no、created_at、UUID 一概不参与排序，
 * 因为迟到落地的业务 version_no 会大于它在业务上更晚的业务（DEC-108 / DEC-195①）。
 * 8c-2c 的“生效子项写档案”复用本文件的位置解析与折叠，保证读与写同一口径。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { rowsOf } from '../employment/record-store.js';
import { loadPlannedEffectiveDate, operationKey } from '../employment/timeline.js';

export interface InsuranceOrigin {
  readonly regionCode: string | null;
  readonly planId: string | null;
  readonly companyId: string | null;
}

/** 业务位置：与档案事件的排序三元组同形，文本形态（日期 ISO，操作先后为 bigint 的十进制文本）。 */
export interface InsurancePosition {
  readonly effectiveDate: string;
  readonly plannedDate: string;
  readonly operationSeq: string;
}

/** 位置未定（业务还没写状态事件，或不指定业务）时视为最晚：同日全部事件都算前驱。 */
const LATEST_SEQ = '9223372036854775807';
const LATEST_DATE = 'infinity';

export const NO_INSURANCE_ORIGIN: InsuranceOrigin = { regionCode: null, planId: null, companyId: null };

/** 纯折叠：events 须已按业务先后升序；每个事件只覆盖自己的非空值，没有事件时三个值都为空。 */
/** 员工范围外、员工不存在、业务编号归属不符共用同一句话：三种 404 不能靠文案区分（AC-INS-09 / 10）。 */
export const NOT_FOUND_MESSAGE = '任职数据不存在';

export function foldInsuranceEvents(events: readonly Partial<InsuranceOrigin>[]): InsuranceOrigin {
  return events.reduce<InsuranceOrigin>(
    (origin, event) => ({
      regionCode: event.regionCode ?? origin.regionCode,
      planId: event.planId ?? origin.planId,
      companyId: event.companyId ?? origin.companyId,
    }),
    NO_INSURANCE_ORIGIN,
  );
}

/**
 * 解析业务位置。带业务编号：服务端核对业务属于本租户且属于该员工（别的租户 / 别的员工 / 不存在同一个 404，不泄露存在性），
 * 位置 = （单据自己的实际生效日、该业务的计划生效日、该业务的操作先后），全部取自服务端单据；
 * 客户端的 effectiveDate 不得移动已有业务的前驱边界（与查询参数不一致时按单据位置，不报错，设计 §4.1）。
 * 单据还没有任何载荷版本时才退回查询日，作为位置的兜底。
 * 不带业务编号（新建预览）：取查询日当天最后一次操作之后，即所有生效日不晚于查询日的事件都是前驱。
 */
export async function insurancePosition(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  effectiveDate: string,
  businessId?: string,
): Promise<InsurancePosition> {
  if (!businessId) return { effectiveDate, plannedDate: LATEST_DATE, operationSeq: LATEST_SEQ };
  const [owned] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM employment_business_objects
      WHERE tenant_id = ${tenantId} AND id = ${businessId}::uuid AND employee_id = ${employeeId}::uuid`),
  );
  if (!owned) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
  // 单据实际生效日 = 最新载荷版本（业务内 version_no 单调）的 effective_date，与计划生效日同一来源表
  const [latest] = rowsOf<{ date: string }>(
    await tx.execute(sql`SELECT effective_date::text AS date FROM employment_payload_versions
      WHERE tenant_id = ${tenantId} AND business_id = ${businessId}::uuid ORDER BY version_no DESC LIMIT 1`),
  );
  const ownDate = latest?.date ?? effectiveDate;
  const plannedDate = await loadPlannedEffectiveDate(tx, tenantId, businessId, ownDate);
  const [key] = rowsOf<{ seq: string | null }>(
    await tx.execute(sql`SELECT ${operationKey(tenantId, sql`${businessId}::uuid`)}::text AS seq`),
  );
  return { effectiveDate: ownDate, plannedDate, operationSeq: key?.seq ?? LATEST_SEQ };
}

/** 读该员工在 position 之前的档案事件并折叠；必须在对应租户的 withTenant 事务内调用。 */
export async function foldInsuranceOrigin(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  position: InsurancePosition,
): Promise<InsuranceOrigin> {
  const events = rowsOf<InsuranceOrigin>(
    await tx.execute(sql`SELECT region_code AS "regionCode", plan_id AS "planId", company_id AS "companyId"
      FROM social_insurance_archive_versions
      WHERE tenant_id = ${tenantId} AND employee_id = ${employeeId}::uuid
        AND (effective_date, planned_effective_date, operation_seq)
          < (${position.effectiveDate}::date, ${position.plannedDate}::date, ${position.operationSeq}::bigint)
      ORDER BY effective_date, planned_effective_date, operation_seq`),
  );
  return foldInsuranceEvents(events);
}
