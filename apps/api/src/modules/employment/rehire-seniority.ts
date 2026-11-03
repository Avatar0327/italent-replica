/** DEC-796：只做离职重聘；实习转正、退休返聘不使用这个开关。 */
import { sql, type Tx } from '@italent/db';
import { tenureYears } from '@italent/domain';
import { AppError } from '../../errors.js';
import { readEffectiveSetting, registerSettingValidator } from '../tenant-settings/service.js';
import { auditEmployment } from './context.js';
import { appendForwardPayload } from './forward-store.js';
import type { ForwardValues } from './forward-rules.js';
import { findPredecessor } from './read-model.js';
import { rowsOf, type LockedEmploymentBusiness } from './record-store.js';
import type { EmploymentContext } from './types.js';

const SETTING = 'employment.rehire_accumulate_seniority';
registerSettingValidator(SETTING, (value) => typeof value === 'boolean');

/** 只从任职落地内核调用；审批、开关修改、查询均不追补已有业务。 */
export async function applyRehireSeniority(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  values: ForwardValues,
  beforeOrder: number,
) {
  if (business.payload.kind !== 'rehire') return values.fields;
  const setting = await readEffectiveSetting(tx, ctx.tenantId, SETTING);
  if (setting.value !== true) return values.fields;
  const previous = await findPredecessor(
    tx,
    ctx.tenantId,
    business.employeeId,
    business.payload.effectiveDate,
    beforeOrder,
  );
  const [exit] = previous
    ? rowsOf<{ lastWorkDate: string | null }>(
        await tx.execute(sql`
    SELECT last_work_date::text AS "lastWorkDate" FROM employment_payload_versions
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${business.employeeId} AND business_id=${previous.id}
    ORDER BY version_no DESC LIMIT 1`),
      )
    : [];
  if (previous?.kind !== 'leave' || !exit?.lastWorkDate)
    throw new AppError('CONFLICT', '重聘累计所需的上一段离职记录不可用');
  const total = tenureYears(previous.entryDate, exit.lastWorkDate, previous.fields.workYearCompanyBefore);
  if (total === null) throw new AppError('CONFLICT', '上一段任职日期无法计算累计司龄');
  if (Number(total) > Number.MAX_SAFE_INTEGER / 100) throw new AppError('VALIDATION_FAILED', '累计司龄超出可保存范围');
  const before = values.fields.workYearCompanyBefore;
  const fields = { ...values.fields, workYearCompanyBefore: Number(total) };
  // 新周期的人工校正值已在原载荷中保存；只记录版本指针，禁止另建“变更前值”列。
  await tx.execute(sql`INSERT INTO employment_rehire_seniority_snapshots
    (tenant_id,employee_id,business_id,snapshot_version_id,created_at)
    VALUES(${ctx.tenantId},${business.employeeId},${business.id},${business.payload.id},${ctx.now.toISOString()})`);
  business.payload = await appendForwardPayload(tx, ctx, business.payload, { ...values, fields }, business.id, true, [
    { field: 'workYearCompanyBefore', before, after: fields.workYearCompanyBefore },
  ]);
  await auditEmployment(
    tx,
    ctx,
    'employment.rehire.seniority',
    'employment-record',
    business.id,
    { workYearCompanyBefore: before },
    { workYearCompanyBefore: fields.workYearCompanyBefore },
    business.payload.id,
  );
  return fields;
}

/** 生效重聘按既有删除任职契约撤销；开关当前状态不影响历史快照恢复。 */
export async function restoreRehireSeniority(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  if (business.payload.kind !== 'rehire') return;
  const [snapshot] = rowsOf<{ value: string }>(
    await tx.execute(sql`
    SELECT p.work_year_company_before::text AS value
    FROM employment_rehire_seniority_snapshots s
    JOIN employment_payload_versions p ON p.tenant_id=s.tenant_id AND p.employee_id=s.employee_id
      AND p.business_id=s.business_id AND p.id=s.snapshot_version_id
    WHERE s.tenant_id=${ctx.tenantId} AND s.employee_id=${business.employeeId} AND s.business_id=${business.id}`),
  );
  if (!snapshot) return;
  const before = business.payload.fields.workYearCompanyBefore;
  const fields = { ...business.payload.fields, workYearCompanyBefore: Number(snapshot.value) };
  business.payload = await appendForwardPayload(
    tx,
    ctx,
    business.payload,
    { fields, customFields: business.payload.customFields },
    business.id,
    true,
    [{ field: 'workYearCompanyBefore', before, after: fields.workYearCompanyBefore }],
  );
  await auditEmployment(
    tx,
    ctx,
    'employment.rehire.seniority.restore',
    'employment-record',
    business.id,
    { workYearCompanyBefore: before },
    { workYearCompanyBefore: fields.workYearCompanyBefore },
    business.payload.id,
  );
}
