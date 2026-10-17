/**
 * 直接实习转正（R2 BE-6a；差距表 B41；R2f B41；DEC-234 实习转正按入职处理）：保存即生效、不走审批，经 main 的任职落地路径
 * （createEmploymentBusiness）新起主职——原任职按版本链在转正日前一天结束、雇佣关系改内部员工、变动类型“实习转正”、
 * 有试用期为“试用”否则“正式”。不经离职生效（activateExit）、不打开 §18.1 关口（00 10-17 指示）。
 */
import type { Tx } from '@italent/db';
import { PROBATION_MONTH_OPTIONS, probationExpectedEnd } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { employmentEstablishmentAssessment } from '../establishment/employment-check.js';
import { auditEmployment } from './context.js';
import { saveRecordProbation, type RecordProbation } from './entry-probation.js';
import { businessDate } from './fields.js';
import type { EmploymentBusiness, EmploymentContext, PresetFields } from './types.js';
import { createEmploymentBusiness } from './write-service.js';

const id = z.uuid();
/**
 * 表单五区里由请求提交的部分（R2f B41）：任职信息（实习转正日期*、部门*、职位、是否有试用期*）、试用期信息
 * （月数* 1～6、预计结束*：不传按月数算）、汇报关系；合同协议本次不新增、员工信息只是带出，都不受理。
 * 入职日期与工号不受理：任职工号 = 员工编码、入职日期沿用同周期（main 现状，见 PR“偏离”）。confirmed = 已确认超编提示。
 */
export const internRegularizationInput = z
  .strictObject({
    effectiveDate: z.string().min(1),
    departmentId: id,
    positionId: id.nullable().optional(),
    directManagerId: id.nullable().optional(),
    dottedManagerId: id.nullable().optional(),
    probation: z.boolean(),
    probationMonths: z.literal([...PROBATION_MONTH_OPTIONS]).optional(),
    probationEndDate: z.string().min(1).optional(),
    confirmed: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.probation
        ? input.probationMonths !== undefined
        : input.probationMonths === undefined && input.probationEndDate === undefined,
    { message: '有试用期时必须填写试用期(月)；无试用期时不能填写试用期信息', path: ['probationMonths'] },
  );
export type InternRegularizationInput = z.infer<typeof internRegularizationInput>;

/** 写入的任职字段（字段写权限、数据范围都按它校验）：部门 + 请求里给出的职位 / 汇报关系。 */
export function regularizationFields(input: InternRegularizationInput): Partial<PresetFields> {
  const { departmentId, positionId, directManagerId, dottedManagerId } = input;
  const given = Object.entries({ positionId, directManagerId, dottedManagerId }).filter(([, v]) => v !== undefined);
  return { departmentId, ...Object.fromEntries(given) };
}

/** 试用期信息：开始 = 转正日，预计结束不传按月数算，传了（可手改，R2e6 / R2f B41）不得早于开始。 */
function regularizationProbation(input: InternRegularizationInput): RecordProbation | null {
  if (!input.probation) return null;
  const startDate = businessDate(input.effectiveDate);
  const months = input.probationMonths!;
  const endDate = input.probationEndDate
    ? businessDate(input.probationEndDate)
    : probationExpectedEnd(startDate, months);
  if (endDate < startDate) throw new AppError('VALIDATION_FAILED', '预计试用结束日期不能早于实习转正日期');
  return { startDate, months, endDate };
}

export async function regularizeIntern(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: InternRegularizationInput,
): Promise<EmploymentBusiness> {
  const probation = regularizationProbation(input);
  // 资格检查（intern-eligibility.ts）与员工锁、业务顺序校验都在 createEmploymentBusiness 内，与通用新增接口同一入口（F-215）
  const business = await createEmploymentBusiness(
    tx,
    ctx,
    employeeId,
    {
      kind: 'intern_regularization',
      mode: 'direct',
      effectiveDate: input.effectiveDate,
      fields: regularizationFields(input),
    },
    { entry: { probation: input.probation } },
  );
  await confirmEstablishment(tx, ctx, business, input.confirmed === true);
  if (probation) {
    await saveRecordProbation(tx, ctx, employeeId, business.id, probation);
    // 试用期信息是字段级变更（DEC-019），与落地同事务审计
    await auditEmployment(tx, ctx, 'employment.record.probation', 'employment-record', business.id, null, {
      probationStartDate: probation.startDate,
      probationMonths: probation.months,
      probationEndDate: probation.endDate,
    });
  }
  return business;
}

/**
 * 编制单一判定入口（establishment/employment-check.ts）：严格控编超编已在落地时整单拒绝（ESTABLISHMENT_EXCEEDED）；
 * 非严格控编超编先提示（CONFIRMATION_REQUIRED，整单回滚），用户确认后带 confirmed 以新命令重提（R2f B41：先弹超编确认）。
 */
async function confirmEstablishment(tx: Tx, ctx: EmploymentContext, business: EmploymentBusiness, confirmed: boolean) {
  const record = business.record;
  if (confirmed || !record?.fields.departmentId) return;
  const assessment = await employmentEstablishmentAssessment(tx, ctx, {
    businessId: business.id,
    employeeId: business.employeeId,
    kind: business.kind,
    effectiveDate: record.effectiveDate,
    departmentId: record.fields.departmentId,
    positionId: record.fields.positionId,
    fields: record.fields,
  });
  if (assessment === 'warning')
    throw new AppError('CONFLICT', '已超出设定编制，确认后继续保存', {
      reason: 'CONFIRMATION_REQUIRED',
      warnings: [{ departmentId: record.fields.departmentId, reason: 'ESTABLISHMENT_EXCEEDED' }],
    });
}
