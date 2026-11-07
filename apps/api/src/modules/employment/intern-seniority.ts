/**
 * DEC-797：实习转正重置入职日，并按【实习转正】累计司龄开关写司龄校正值。
 * 与 rehire-seniority.ts（DEC-796，只管离职重聘）是两个独立开关，互不影响。
 * 入职日 = 转正日由 write-service 开新任职周期实现；实习开始日存在新周期上（employment_cycles.trainee_start_date），
 * 撤销（删除）转正时随记录一起摘除，实习段记录与它的校正值从未被改写，所以无需另存“变更前”。
 */
import { tenureYears } from '@italent/domain';
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { readEffectiveSetting, registerSettingValidator } from '../tenant-settings/service.js';
import type { ForwardValues } from './forward-rules.js';
import type { LockedEmploymentBusiness } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const INTERN_SENIORITY_SETTING = 'employment.intern_regularization_accumulate_seniority';
registerSettingValidator(INTERN_SENIORITY_SETTING, (value) => typeof value === 'boolean');

/**
 * 校正值 = 实习段（实习开始日 → 转正日）满的年数 + 转正前已有的校正值，按 tenureYears 的同一口径取一位小数向下舍位。
 * 之后累计司龄 = (当前日期 − 转正日)/365 + 校正值，与实习期不中断时一致；不会把实习段计入两次。
 * 只在落地时读开关（申请方式以到期落地时为准，审批通过不写）；开关关闭时保留原值。
 */
export async function applyInternSeniority(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  values: ForwardValues,
  traineeStartDate: string | undefined,
) {
  if (business.payload.kind !== 'intern_regularization' || !traineeStartDate) return values.fields;
  const setting = await readEffectiveSetting(tx, ctx.tenantId, INTERN_SENIORITY_SETTING);
  if (setting.value !== true) return values.fields;
  const total = tenureYears(traineeStartDate, business.payload.effectiveDate, values.fields.workYearCompanyBefore);
  if (total === null) throw new AppError('CONFLICT', '实习段日期无法计算累计司龄');
  if (Number(total) > Number.MAX_SAFE_INTEGER / 100) throw new AppError('VALIDATION_FAILED', '累计司龄超出可保存范围');
  return { ...values.fields, workYearCompanyBefore: Number(total) };
}
