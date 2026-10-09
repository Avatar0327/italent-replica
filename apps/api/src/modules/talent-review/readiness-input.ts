/**
 * 准备度请求结构（只做结构校验，不读库）。严格对象：未登记的键一律 400，编码建后不可改，修改结构不收 code。
 * 原站编码规则未取证，只限长度；颜色按原站字典“每项带颜色”取 #RRGGBB（🟡）。
 */
import { READINESS_COLOR_PATTERN } from '@italent/domain';
import { z } from 'zod';

export const readinessCreate = z.strictObject({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(50),
  description: z.string().trim().max(500).nullable().optional(),
  color: z.string().regex(READINESS_COLOR_PATTERN, '颜色须为 #RRGGBB'),
  sortNo: z.int().min(0).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
});
export const readinessPatch = readinessCreate.omit({ code: true }).partial();

export type ReadinessCreate = z.output<typeof readinessCreate>;
export type ReadinessPatch = z.output<typeof readinessPatch>;
