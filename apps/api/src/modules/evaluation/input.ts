/**
 * 人才评定配置各接口的请求结构（只做结构校验，不读库）。严格对象：未登记的键（活动类型没有“同步任职记录”，DEC-025；
 * 所属人、创建人由系统填写）一律 400。名称长度同任职资格配置（≤100）。
 */
import { z } from 'zod';

// 名称租户内唯一由库内约束 + service 转 409（Q-M0-152）；这里 trim，所以首尾空白不构成不同名称
const name = z.string().trim().min(1).max(100);
const order = z.int().min(0).max(1_000_000);

export const activityTypeCreate = z.strictObject({
  name,
  displayOrder: order.optional(),
  enabled: z.boolean().optional(),
  syncQualification: z.boolean().optional(),
});
export const activityTypePatch = activityTypeCreate.partial();
export type ActivityTypeCreate = z.infer<typeof activityTypeCreate>;
export type ActivityTypePatch = z.infer<typeof activityTypePatch>;

// 活动周期、通用评分项：名称是否唯一规格与取证都没有（TODO(需取证 #196)），暂不拦重名
export const activityCycleCreate = z.strictObject({ name, enabled: z.boolean().optional() });
export const activityCyclePatch = activityCycleCreate.partial();
export type ActivityCycleCreate = z.infer<typeof activityCycleCreate>;
export type ActivityCyclePatch = z.infer<typeof activityCyclePatch>;

export const generalScoreItemCreate = z.strictObject({
  name,
  description: z.string().trim().max(4000).nullable().optional(),
  enabled: z.boolean().optional(),
});
export const generalScoreItemPatch = generalScoreItemCreate.partial();
export type GeneralScoreItemCreate = z.infer<typeof generalScoreItemCreate>;
export type GeneralScoreItemPatch = z.infer<typeof generalScoreItemPatch>;
