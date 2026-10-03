import { EMPLOYEE_FIELDS, SUBSETS, type PersonnelField, type SubsetKind } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { Row } from './store.js';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });
export const dateValue = (value: string) => parse(isoDate, value);
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  // Never include submitted values in validation errors (ID/contact/family fields).
  if (!result.success) throw new AppError('VALIDATION_FAILED', '人员字段不合法');
  return result.data;
}
export function subsetKind(value: string): SubsetKind {
  if (!Object.hasOwn(SUBSETS, value)) throw new AppError('NOT_FOUND', '人员子集不存在');
  return value as SubsetKind;
}
function fieldSchema(field: PersonnelField): z.ZodType {
  switch (field.kind) {
    case 'boolean':
      return z.boolean();
    case 'date':
      return isoDate;
    case 'uuid':
      return z.uuid();
    case 'integer':
      return z.number().int().nonnegative().max(2147483647);
    case 'decimal':
      return z.number().finite().nonnegative().max(1e12);
    case 'email':
      return z.email().max(320);
    default:
      return z.string().trim().max(2000);
  }
}
export function parseFields(fields: readonly PersonnelField[], value: unknown): Row {
  const shape = Object.fromEntries(
    fields.filter((field) => !field.system).map((field) => [field.code, fieldSchema(field).nullable().optional()]),
  );
  const result = parse(z.object(shape).strict(), value);
  if (!Object.keys(result).length) throw new AppError('VALIDATION_FAILED', '必须提供要修改的字段');
  return result;
}
export function employeeInput(value: unknown): Row {
  const result = parseFields(EMPLOYEE_FIELDS, value);
  if ('name' in result && (typeof result.name !== 'string' || !result.name.length))
    throw new AppError('VALIDATION_FAILED', '姓名不能为空');
  // TODO(R2)：仅记录重聘模式，完整合并/新建人员流程由 REQ-EMP-005 实现。
  if ('rehireType' in result && ![null, 'merge', 'new_person'].includes(result.rehireType as string | null))
    throw new AppError('VALIDATION_FAILED', '重聘方式不合法');
  return result;
}
export function subsetInput(kind: SubsetKind, value: unknown, internal = false): Row {
  const fields: PersonnelField[] = [...SUBSETS[kind].fields];
  const parsed = parseFields(fields, value);
  // DEC-087: provenance is assigned by trusted server-side ports, never accepted from an HTTP patch.
  void internal;
  return parsed;
}
export function validateDates(row: Row) {
  for (const [start, end] of [
    ['startDate', 'endDate'],
    ['idStartDate', 'idEndDate'],
    ['cycleStartDate', 'cycleEndDate'],
  ]) {
    if (row[start!] && row[end!] && String(row[start!]) > String(row[end!]))
      throw new AppError('VALIDATION_FAILED', '结束日期不能早于开始日期');
  }
}
