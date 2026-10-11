/**
 * 人才评定配置各接口的请求结构（只做结构校验，不读库）。严格对象：未登记的键（活动类型没有“同步任职记录”，DEC-025；
 * 所属人、创建人由系统填写）一律 400。名称长度同任职资格配置（≤100）。
 */
import { z } from 'zod';
import { roundDecimal } from '@italent/domain';

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

// 活动周期：只有名称（没有描述字段，DEC-380①）；名称长度按系统统一上限（D-069），租户内唯一由库内约束 + 服务转 409
export const activityCycleCreate = z.strictObject({ name, enabled: z.boolean().optional() });
export const activityCyclePatch = activityCycleCreate.partial();
export type ActivityCycleCreate = z.infer<typeof activityCycleCreate>;
export type ActivityCyclePatch = z.infer<typeof activityCyclePatch>;

export const generalScoreItemCreate = z.strictObject({
  name,
  // “评价标准”最多 500 字，超出提示原站原文（DEC-380②）
  description: z.string().trim().max(500, '最多输入500个字').nullable().optional(),
  enabled: z.boolean().optional(),
});
export const generalScoreItemPatch = generalScoreItemCreate.partial();
export type GeneralScoreItemCreate = z.infer<typeof generalScoreItemCreate>;
export type GeneralScoreItemPatch = z.infer<typeof generalScoreItemPatch>;
// ── 评审组（B3，照原站 DEC-393）──────────────────────────────────────────
// 没有编码字段；名称必填（多语言字段首版只做简体中文，DEC-045）、不要求唯一；允许零成员；成员上限 200 是系统保护（🟡，差异 D-071，
// 原站未标示，待取证可推翻），超出提示分批。
export const MAX_REVIEW_MEMBERS = 200;
const uuid = z.uuid().transform((value) => value.toLowerCase());
/** 成员整组提交；组长至多 1 个（DEC-400②）、成员不重复由写入服务校验（带 reason）。 */
const memberList = z.array(z.strictObject({ employeeId: uuid, isLeader: z.boolean() })).max(MAX_REVIEW_MEMBERS, {
  error: `一个评审组最多 ${MAX_REVIEW_MEMBERS} 人，请分批添加`,
});

// 所属人由系统填创建人，所属组织必填手选（DEC-324②）
export const reviewGroupCreate = z.strictObject({
  name,
  ownerOrgId: uuid,
  enabled: z.boolean().optional(),
  members: memberList,
});
export const reviewGroupPatch = reviewGroupCreate.partial();
export type ReviewGroupCreate = z.infer<typeof reviewGroupCreate>;
export type ReviewGroupPatch = z.infer<typeof reviewGroupPatch>;

// DEC-413 / 规格 24 Q-M0-175：无编码、不校验名称唯一；通用项是多选集合、不设数量上限。
export const FORM_SCORE_MODES = ['by_indicator', 'by_total', 'by_vote'] as const;
const twoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
// 按十进制截位，不用乘 100 的浮点运算；15 位数字包括整数与保留的小数（小数点不计位数）。
const score = z
  .number()
  .transform((value) => roundDecimal(value, 2, 'down'))
  .refine((value) => value > 0, '请设置大于0的数字')
  .refine((value) => value < 1e15 && String(value).replace('.', '').length <= 15, '最多输入15位数字');
const weight = z.number().refine(twoDecimals, '最多 2 位小数').nullable().optional();
const standardItem = z.strictObject({
  kind: z.literal('standard'),
  weight,
  hiddenTargetIds: z.array(uuid).max(500).optional(),
});
const generalItem = z.strictObject({ kind: z.literal('general'), generalItemId: uuid, weight });
const formItems = z.array(z.discriminatedUnion('kind', [standardItem, generalItem]));
export const formCreate = z.strictObject({
  name,
  ownerOrgId: uuid,
  enabled: z.boolean().optional(),
  scoreMode: z.enum(FORM_SCORE_MODES),
  fullScore: score.nullable().optional(),
  passScore: score.nullable().optional(),
  totalRule: z.enum(['average', 'weighted', 'sum']).nullable().optional(),
  votePassRatio: z.number().min(0).max(100).nullable().optional(),
  indicatorReference: z.boolean().optional(),
  items: formItems,
});
export const formPatch = formCreate.partial();
export type FormCreate = z.infer<typeof formCreate>;
export type FormPatch = z.infer<typeof formPatch>;
export type FormItemInput = FormCreate['items'][number];
