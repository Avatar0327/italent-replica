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

// ── 评审组（B3）──────────────────────────────────────────────
export const MAX_REVIEW_MEMBERS = 200;
const groupCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/, '编码只能包含字母、数字、下划线与连字符，最长 50 位');
const uuid = z.uuid().transform((value) => value.toLowerCase());
/** 成员整组提交；组长恰好 1 个、成员不重复由写入服务校验（带 reason）。 */
const memberList = z
  .array(z.strictObject({ employeeId: uuid, isLeader: z.boolean() }))
  .min(1)
  .max(MAX_REVIEW_MEMBERS);

// 所属人由系统填创建人，所属组织必填手选（DEC-324②）
export const reviewGroupCreate = z.strictObject({
  code: groupCode,
  name,
  ownerOrgId: uuid,
  enabled: z.boolean().optional(),
  members: memberList,
});
export const reviewGroupPatch = reviewGroupCreate.partial();
export type ReviewGroupCreate = z.infer<typeof reviewGroupCreate>;
export type ReviewGroupPatch = z.infer<typeof reviewGroupPatch>;
