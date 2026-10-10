/**
 * 人才评定配置各接口的请求结构（只做结构校验，不读库）。严格对象：未登记的键（活动类型没有“同步任职记录”，DEC-025；
 * 所属人、创建人由系统填写）一律 400。名称长度同任职资格配置（≤100）。
 */
import { APPLICANT_MODES, CHAIN_TYPES, TRANSFER_MODES } from '@italent/domain';
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

// ── 评价表（B4，标准模式）──────────────────────────────────────────────
// 没有编码字段、名称不要求唯一（照评审组 DEC-393 的经验，原站未证实，需取证 #216）。评分项数量上限 50 是系统保护 🟡。
export const FORM_SCORE_MODES = ['by_indicator', 'by_total'] as const;
export const MAX_FORM_ITEMS = 50;
const twoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
// 满分 / 通过分数的存储是 numeric(8,2)：上限 999999.99，超出 400 而不是溢出成 500
const MAX_SCORE = 999_999.99;
const score = z.number().max(MAX_SCORE, '分数过大').refine(twoDecimals, '最多 2 位小数');
const weight = z.number().refine(twoDecimals, '最多 2 位小数').nullable().optional();
const standardItem = z.strictObject({
  kind: z.literal('standard'),
  weight,
  hiddenTargetIds: z.array(uuid).max(500).optional(),
});
const generalItem = z.strictObject({ kind: z.literal('general'), generalItemId: uuid, weight });
const formItems = z.array(z.discriminatedUnion('kind', [standardItem, generalItem])).max(MAX_FORM_ITEMS, {
  error: `评分项最多 ${MAX_FORM_ITEMS} 个`,
});
export const formCreate = z.strictObject({
  name,
  ownerOrgId: uuid,
  enabled: z.boolean().optional(),
  scoreMode: z.enum(FORM_SCORE_MODES),
  fullScore: score.refine((value) => value > 0, '满分须大于 0'),
  passScore: score.refine((value) => value >= 0, '通过分数不能为负'),
  totalRule: z.enum(['average', 'weighted', 'sum']).nullable().optional(),
  items: formItems,
});
export const formPatch = formCreate.partial();
export type FormCreate = z.infer<typeof formCreate>;
export type FormPatch = z.infer<typeof formPatch>;
export type FormItemInput = FormCreate['items'][number];

// ── 评定活动（B5，设计 §3.2）────────────────────────────────────────────
// 必填项 / 编码 / 申请人取值 / 范围形态等规格未写到的口径按保守默认，列表上限是系统保护 🟡。
// TODO(需取证 #225)：活动编码、必填项、申请人取值、适用范围形态、环节字段适用性、转入方式缺省等取证后对表改。
export const MAX_ACTIVITY_ORGS = 200;
export const MAX_ACTIVITY_CATEGORIES = 100;
export const MAX_ACTIVITY_LEVELS = 500;
const date = z.iso.date();
const orgList = z.array(uuid).max(MAX_ACTIVITY_ORGS, { error: `组织最多 ${MAX_ACTIVITY_ORGS} 个` });
/** 可空短文本：空串当作未设置（资格审批流程清空走“必填”规则，不是格式错误）。 */
const shortText = z
  .string()
  .trim()
  .max(100)
  .nullable()
  .optional()
  .transform((value) => (value ? value : null));
const chainInput = z.strictObject({
  type: z.enum(CHAIN_TYPES),
  name,
  startDate: date,
  endDate: date,
  formId: uuid.nullable().optional(),
  approvalProcessCode: shortText,
  materialTemplate: shortText,
  hardDeadline: z.boolean().optional(),
  allowException: z.boolean().optional(),
  exceptionRoles: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  transferMode: z.enum(TRANSFER_MODES).optional(),
  noticeTemplateCode: shortText,
});
export type ChainInput = z.infer<typeof chainInput>;
export const activityCreate = z.strictObject({
  code: z.string().trim().min(1).max(50),
  name,
  typeId: uuid,
  cycleId: uuid,
  year: z.int().min(2000).max(2100),
  startDate: date,
  endDate: date,
  ownerOrgId: uuid,
  orgRange: orgList.optional(),
  managerEmployeeId: uuid.nullable().optional(),
  applicantMode: z.enum(APPLICANT_MODES),
  categoryIds: z.array(uuid).max(MAX_ACTIVITY_CATEGORIES).optional(),
  levelIds: z.array(uuid).max(MAX_ACTIVITY_LEVELS).optional(),
  // 必填 1～5 的整数，新建未传取 1；显式 null / 0 / 6 / 小数一律 400，没有“不限”（DEC-372②）
  maxLevelJump: z.int().min(1).max(5).optional(),
  effectiveDate: date.nullable().optional(),
  noticeOrgRange: orgList.optional(),
  chains: z.array(chainInput).max(CHAIN_TYPES.length),
});
export const activityPatch = activityCreate.partial();
export type ActivityCreate = z.infer<typeof activityCreate>;
export type ActivityPatch = z.infer<typeof activityPatch>;
