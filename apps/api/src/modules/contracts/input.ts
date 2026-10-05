import { z } from 'zod';
import { AppError } from '../../errors.js';
const day = z.iso.date();
const money = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/)
  .nullable();
export const fieldsSchema = z.strictObject({
  number: z.string().trim().min(1).max(100).optional(),
  typeId: z.uuid().optional(),
  companyId: z.uuid().optional(),
  termType: z.enum(['fixed', 'indefinite', 'task']).optional(),
  termMonths: z.int().min(1).max(1200).nullable().optional(),
  signingDate: day.nullable().optional(),
  effectiveDate: day.optional(),
  endDate: day.nullable().optional(),
  actualTerminationDate: day.nullable().optional(),
  probationStartDate: day.nullable().optional(),
  probationEndDate: day.nullable().optional(),
  probationSalary: money.optional(),
  regularSalary: money.optional(),
  employmentRecordId: z.uuid().nullable().optional(),
  sourceCode: z.string().max(100).nullable().optional(),
  customFields: z
    .record(z.uuid(), z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]))
    .optional(),
});
export const commandSchema = z.strictObject({
  operation: z.enum(['create', 'renew', 'change', 'terminate']),
  mode: z.enum(['direct', 'application']),
  employeeId: z.uuid(),
  targetId: z.uuid().optional(),
  fields: fieldsSchema,
});
export type ContractCommand = z.infer<typeof commandSchema>;
export type ContractFields = z.infer<typeof fieldsSchema>;
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_FAILED', '合同请求字段不合法', result.error.issues);
  return result.data;
}
export const settingsSchema = z.strictObject({
  autoRenew: z.boolean().optional(),
  autoTerminate: z.boolean().optional(),
  autoNumber: z.boolean().optional(),
  accumulateRehire: z.boolean().optional(),
  postExitTypeIds: z.array(z.uuid()).max(100).optional(),
  renewalTypeIds: z.array(z.uuid()).max(100).optional(),
  indefiniteTypeIds: z.array(z.uuid()).max(100).optional(),
  uniqueFields: z.enum(['number', 'employeeId', 'typeId', 'effectiveDate']).array().min(1).max(4).optional(),
});
export const ruleSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  priority: z.int().min(0),
  enabled: z.boolean().default(true),
  orgIds: z.array(z.uuid()).max(1000),
  personIds: z.array(z.uuid()).max(1000),
  details: z
    .array(
      z.strictObject({
        typeId: z.uuid(),
        months: z.int().min(1).max(1200),
        initiatorId: z.uuid(),
        daysBefore: z.int().min(0).max(3660),
        skipTypeIds: z.array(z.uuid()).max(100),
      }),
    )
    .min(1)
    .max(100),
});
