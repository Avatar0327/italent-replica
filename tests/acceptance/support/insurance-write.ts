/**
 * F-474-8c-2c：调动联动写社保三项调整值的验收夹具。调动单经真实 HR 调动入口带 linkage 保存，审批通过用可信端口，
 * 生效走真实定时任务；方案 / 公司 / 档案版本的读取用属主身份（普通角色 app_owner 下同样可跑）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { D, linkageWorld } from '../AC-LNK-support.js';
import { asOwner, rowsOf } from './insurance-tables.js';
import { uniqueSuffix } from './unique.js';

export interface Adjust {
  adjustedInsuranceRegionCode?: string | null;
  adjustedInsurancePlanId?: string | null;
  adjustedInsuranceCompanyId?: string | null;
}
export interface InsuranceItemRow {
  id: string;
  revision: number;
  itemType: string;
  status: string;
  attemptCount: number;
  failureCode: string | null;
  effectiveDate: string;
}
export interface ArchiveVersion {
  versionNo: number;
  businessId: string;
  effectiveDate: string;
  plannedDate: string;
  seq: string;
  regionCode: string | null;
  planId: string | null;
  companyId: string | null;
}

export async function insuranceWriteWorld(db: Db, label: string) {
  const w = await linkageWorld(db, label);
  const tenantId = w.session.tenant.id;

  const company = async (code: string, enabled = true): Promise<string> => {
    const id = randomUUID();
    await asOwner(db, tenantId, (tx) =>
      tx.execute(sql`INSERT INTO contract_companies (id, tenant_id, code, name, enabled)
        VALUES (${id}, ${tenantId}, ${`${code}-${uniqueSuffix()}`}, ${`公司${code}`}, ${enabled})`),
    );
    return id;
  };

  /** 方案头 + 一条版本；month 为生效月（1 号），stop 为停用月。 */
  const plan = async (code: string, region: string, month: string, options: { stop?: string } = {}) => {
    const id = randomUUID();
    await asOwner(db, tenantId, async (tx) => {
      await tx.execute(sql`INSERT INTO social_insurance_plans (tenant_id, id, code)
        VALUES (${tenantId}, ${id}, ${`${code}-${uniqueSuffix()}`})`);
      await tx.execute(sql`INSERT INTO social_insurance_plan_versions
        (tenant_id, plan_id, name, region_code, effective_month, stop_month, enabled)
        VALUES (${tenantId}, ${id}, ${`方案${code}`}, ${region}, ${month}, ${options.stop ?? null}, true)`);
    });
    return id;
  };

  /** 保存后方案被停用（生效时业务拒绝的场景）：所有版本改为停用。 */
  const disablePlan = (planId: string) =>
    asOwner(db, tenantId, (tx) =>
      tx.execute(sql`UPDATE social_insurance_plan_versions SET enabled=false
        WHERE tenant_id=${tenantId} AND plan_id=${planId}`),
    );
  const enablePlan = (planId: string) =>
    asOwner(db, tenantId, (tx) =>
      tx.execute(sql`UPDATE social_insurance_plan_versions SET enabled=true
        WHERE tenant_id=${tenantId} AND plan_id=${planId}`),
    );

  /** 该员工的社保档案版本，按追加顺序（version_no）。 */
  const archive = (employeeId: string): Promise<ArchiveVersion[]> =>
    asOwner(db, tenantId, async (tx) =>
      rowsOf<ArchiveVersion>(
        await tx.execute(sql`SELECT version_no AS "versionNo", source_business_id AS "businessId",
            effective_date::text AS "effectiveDate", planned_effective_date::text AS "plannedDate",
            operation_seq::text AS seq, region_code AS "regionCode", plan_id AS "planId", company_id AS "companyId"
          FROM social_insurance_archive_versions WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
          ORDER BY version_no`),
      ),
    );

  /** 调动联动保存的三项调整值（联动版本表三列，8c-2a 已建）。 */
  const savedAdjust = (businessId: string) =>
    asOwner(db, tenantId, async (tx) =>
      rowsOf<{ region: string | null; plan: string | null; company: string | null }>(
        await tx.execute(sql`SELECT adjusted_insurance_region_code AS region, adjusted_insurance_plan_id AS plan,
            adjusted_insurance_company_id AS company FROM transfer_linkage_versions
          WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid ORDER BY version_no`),
      ),
    );

  /** 登记在联动里的社保子项（insurance_archive），按行号。 */
  const insuranceItems = (businessId: string) =>
    asOwner(db, tenantId, async (tx) =>
      rowsOf<InsuranceItemRow>(
        await tx.execute(sql`SELECT id, revision, item_type AS "itemType", status, attempt_count AS "attemptCount",
            failure_code AS "failureCode", effective_date::text AS "effectiveDate"
          FROM transfer_linkage_items WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid
            AND item_type='insurance_archive' ORDER BY line_no`),
      ),
    );

  const audits = (businessId: string) =>
    withTenant(db, tenantId, async (tx) =>
      rowsOf<{ action: string; after: Record<string, unknown> | null }>(
        await tx.execute(sql`SELECT action, after FROM audit_events
          WHERE tenant_id=${tenantId} AND object_id=${businessId} ORDER BY occurred_at, id`),
      ),
    );

  /** 保存调动（HR 入口，申请模式，提交）并断言 201。 */
  async function submitTransfer(
    person: { employee: { id: string } },
    date: string,
    adjust: Adjust,
    fields: Record<string, unknown> = { place: `地点${uniqueSuffix()}` },
  ) {
    const response = await w.transfer(person, { effectiveDate: date, fields, linkage: adjust });
    return w.saved(response);
  }

  const MONTH = `${D.slice(0, 7)}-01`;
  return {
    ...w,
    tenantId,
    company,
    plan,
    disablePlan,
    enablePlan,
    archive,
    savedAdjust,
    insuranceItems,
    audits,
    submitTransfer,
    MONTH,
    expectOk: async (response: Response, status = 200) =>
      expect(response.status, await response.clone().text()).toBe(status),
  };
}

export type InsuranceWriteWorld = Awaited<ReturnType<typeof insuranceWriteWorld>>;
