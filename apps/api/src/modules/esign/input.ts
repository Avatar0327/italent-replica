/** 电子签配置接口的请求体校验（F-481 设计 §3.2、§5.4）；错误一律 400 VALIDATION_FAILED。 */
import { ESIGN_VALIDITY_DAYS_MAX, ESIGN_VALIDITY_DAYS_MIN } from '@italent/domain';
import { z } from 'zod';

const name = z.string().min(1).max(100);
const body = z.string().max(20000);
const sortOrder = z.number().int().min(-1_000_000).max(1_000_000);

export const createTemplateSchema = z.strictObject({
  code: z.string().trim().min(1).max(100),
  name,
  body,
  sortOrder: sortOrder.optional(),
});

/** 编码创建后不可改（DEC-060）：strictObject 把带 code 的请求拒为 400。 */
export const patchTemplateSchema = z
  .strictObject({
    name: name.optional(),
    body: body.optional(),
    status: z.enum(['enabled', 'disabled']).optional(),
    sortOrder: sortOrder.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '至少修改一个字段');

export const sceneSettingsSchema = z.strictObject({
  validityDays: z.number().int().min(ESIGN_VALIDITY_DAYS_MIN).max(ESIGN_VALIDITY_DAYS_MAX),
  remindBeforeExpiry: z.boolean(),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type PatchTemplateInput = z.infer<typeof patchTemplateSchema>;
export type SceneSettingsInput = z.infer<typeof sceneSettingsSchema>;
