import { z } from 'zod';
import { AppError } from '../../errors.js';
import { validIsoDate } from '../org/read-model.js';
import {
  BUSINESS_KINDS,
  PRESET_FIELD_NAMES,
  emptyPresetFields,
  type EmploymentContext,
  type EmploymentBusinessPatch,
  type NormalizedEmploymentInput,
  type CustomValue,
} from './types.js';

export const PRESET_FIELDS = PRESET_FIELD_NAMES;
export const INHERITED_FIELDS = PRESET_FIELDS.filter((field) => field !== 'isDepartmentHead' && field !== 'employType');
export const emptyFields = emptyPresetFields;
const uuid = z.uuid().nullable().optional();
const text = z.string().max(2000).nullable().optional();
export const presetFieldsSchema = z.strictObject({
  departmentId: uuid,
  positionId: uuid,
  postId: uuid,
  levelId: uuid,
  gradeId: uuid,
  directManagerId: uuid,
  dottedManagerId: uuid,
  sequenceId: uuid,
  professionalLineId: uuid,
  place: text,
  employmentType: text,
  employmentSource: text,
  employmentForm: text,
  dimension1: text,
  dimension2: text,
  dimension3: text,
  dimension4: text,
  dimension5: text,
  jobNumber: z.string().trim().min(1).max(100).nullable().optional(),
  remarks: text,
  isKeyPerson: z.boolean().nullable().optional(),
  isDepartmentHead: z.boolean().nullable().optional(),
  employType: z.enum(['internal', 'intern', 'external']).nullable().optional(),
});
const date = z.string().refine(validIsoDate, '日期必须为合法 YYYY-MM-DD');
const customFields = z
  .record(z.uuid(), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 200, '自定义字段最多 200 项');
const formId = z.string().trim().min(1).max(100);
const businessSchema = z.strictObject({
  kind: z.enum(BUSINESS_KINDS),
  mode: z.enum(['direct', 'application']),
  effectiveDate: date.optional(),
  lastWorkDate: date.nullable().optional(),
  formId: formId.default('standard'),
  fields: presetFieldsSchema.default({}),
  customFields: customFields.default({}),
  staffId: z.uuid().optional(),
});
const patchSchema = z.strictObject({
  effectiveDate: date.optional(),
  lastWorkDate: date.nullable().optional(),
  fields: presetFieldsSchema.optional(),
  customFields: customFields.optional(),
});

export function normalizeEmploymentInput(_ctx: EmploymentContext, value: unknown): NormalizedEmploymentInput {
  const parsed = businessSchema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '任职业务字段不合法', parsed.error.issues);
  const input = parsed.data;
  let effectiveDate = input.effectiveDate;
  if (input.kind === 'leave' || input.kind === 'retirement') {
    if (!input.lastWorkDate) throw new AppError('VALIDATION_FAILED', '离职或退休必须填写最后工作日');
    const next = dayAfter(input.lastWorkDate);
    if (effectiveDate && effectiveDate !== next) throw new AppError('VALIDATION_FAILED', '生效日必须是最后工作日次日');
    effectiveDate = next;
  } else if (input.lastWorkDate) {
    throw new AppError('VALIDATION_FAILED', '只有离职或退休业务可设置最后工作日');
  }
  if (!effectiveDate) throw new AppError('VALIDATION_FAILED', '必须填写业务生效日期');
  return { ...input, effectiveDate, lastWorkDate: input.lastWorkDate ?? null };
}

export function normalizeBusinessPatch(value: unknown): EmploymentBusinessPatch {
  const parsed = patchSchema.safeParse(value);
  if (!parsed.success || !Object.keys(parsed.data).length)
    throw new AppError('VALIDATION_FAILED', '任职修改字段不合法');
  return parsed.data;
}

export function businessDate(value: string): string {
  if (!validIsoDate(value)) throw new AppError('VALIDATION_FAILED', '业务日期必须为合法 YYYY-MM-DD');
  return value;
}

export function dayAfter(value: string): string {
  businessDate(value);
  const day = new Date(`${value}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return businessDate(day.toISOString().slice(0, 10));
}

export function validateCustomValue(value: unknown, type: string): CustomValue {
  if (value === null) return null;
  const schemas = {
    text: z.string().max(2000),
    integer: z.number().int().safe(),
    decimal: z.number().finite(),
    boolean: z.boolean(),
    date,
  };
  const schema = schemas[type as keyof typeof schemas];
  const parsed = schema?.safeParse(value);
  if (!parsed?.success) throw new AppError('VALIDATION_FAILED', '自定义字段值与字段类型不符');
  return parsed.data;
}
