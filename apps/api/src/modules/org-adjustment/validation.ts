/**
 * 组织调整申请头字段校验（R2-T08 §2.1 / §2.1A，B46：主题、生效日期、调整范围、审批主体组织、调整内容）。
 * 结构用 strict zod（未知字段 400）；调整范围去重保序后再判 1～20（§5.6，400 `ORG_ADJUSTMENT_RANGE_SIZE`）。
 * 内容上限取原站弹窗 1000 字（F273A §4），比库约束 2000 宽松的那一侧不放行。
 */
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { validIsoDate } from '../org/read-model.js';

export const RANGE_MAX = 20;

const uuid = z.uuid().transform((value) => value.toLowerCase());
const fields = {
  subject: z.string().trim().min(1).max(100),
  effectiveDate: z.string().refine(validIsoDate, '生效日期必须为合法 YYYY-MM-DD'),
  content: z.string().max(1000).nullable().optional(),
  approvalSubjectOrgId: uuid,
  // 原始数组只设防滥用的上限；业务上的 1～20 在去重后判定，带 reason
  adjustmentRange: z.array(uuid).max(1000),
};

export const createSchema = z.strictObject(fields);
export const patchSchema = z
  .strictObject({
    subject: fields.subject.optional(),
    effectiveDate: fields.effectiveDate.optional(),
    content: fields.content,
    approvalSubjectOrgId: fields.approvalSubjectOrgId.optional(),
    adjustmentRange: fields.adjustmentRange.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '至少修改一个字段');

export type HeadInput = z.infer<typeof createSchema>;
export type HeadPatch = z.infer<typeof patchSchema>;

/** 去重保序并判数量；返回规范化后的范围。 */
export function normalizeRange(range: readonly string[]): string[] {
  const unique = [...new Set(range)];
  if (unique.length < 1 || unique.length > RANGE_MAX) {
    throw new AppError('VALIDATION_FAILED', `调整范围须选择 1～${RANGE_MAX} 个组织`, {
      reason: 'ORG_ADJUSTMENT_RANGE_SIZE',
      count: unique.length,
    });
  }
  return unique;
}

export function normalizeHead<T extends { adjustmentRange?: string[] | undefined }>(input: T): T {
  return input.adjustmentRange === undefined
    ? input
    : { ...input, adjustmentRange: normalizeRange(input.adjustmentRange) };
}
