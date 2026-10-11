/** B6a-2 的两组版本结构；空数组清空，缺席沿用，绑定证明属于公式输入协议。 */
import { z } from 'zod';
const uuid = z.uuid().transform((id) => id.toLowerCase());
export const stepFormInput = z.strictObject({
  nodeKey: z.string().min(1).max(32),
  roleId: uuid.nullish(),
  purpose: z.enum(['info', 'calibrate_edit', 'successor_edit', 'target_edit']),
  formId: uuid,
});
export const resultRuleInput = z.strictObject({
  targetFieldId: uuid,
  formula: z.string().trim().min(1).max(8000),
  formulaBindings: z
    .array(z.union([uuid, z.literal('context'), z.null()]))
    .max(800)
    .optional(),
  priority: z.int().min(0).max(1_000_000),
});
export type StepFormInput = z.output<typeof stepFormInput>;
export type ResultRuleInput = z.output<typeof resultRuleInput>;
