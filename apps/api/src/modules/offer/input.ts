/**
 * Offer 请求体的严格校验（OF-R1 字段集）：多余字段 400，在字段授权之前拦下，避免被当作无权字段 403。
 * 金额以十进制字符串落库（numeric(14,2)），接口收发数字。
 */
import { OFFER_ENTRIES, OFFER_SOURCES, OFFER_STATUSES, OFFER_TYPES } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';

const text = (max = 200) => z.string().trim().max(max).nullable().optional();
const ref = z.uuid().nullable().optional();
const day = z.iso.date().nullable().optional();
const money = z.number().min(0).max(999_999_999_999).multipleOf(0.01).nullable().optional();

export const OFFER_FIELD_SCHEMA = {
  name: text(100),
  personalEmail: z.email().max(200).nullable().optional(),
  mobile: text(30),
  gender: text(20),
  idType: text(50),
  idNumber: text(50),
  birthDate: day,
  workStartDate: day,
  channelName: text(),
  appliedPosition: text(),
  recruitmentDemand: text(),
  departmentId: ref,
  plannedEntryDate: day,
  positionId: ref,
  postId: ref,
  levelId: ref,
  workPlace: text(),
  hasProbation: z.boolean().nullable().optional(),
  probationMonths: z.int().min(0).max(120).nullable().optional(),
  directManagerId: ref,
  dottedManagerId: ref,
  hrbpId: ref,
  costCenter: text(),
  contractCompanyId: ref,
  contractTermType: text(50),
  contractMonths: z.int().min(0).max(1200).nullable().optional(),
  contractEndDate: day,
  salaryBeforeRegular: money,
  salaryAfterRegular: money,
  socialInsuranceBase: money,
  housingFundBase: money,
};

const createSchema = z.strictObject({
  entry: z.enum(OFFER_ENTRIES),
  offerType: z.enum(OFFER_TYPES).nullable().optional(),
  source: z.enum(OFFER_SOURCES).optional(),
  campusOfferId: z.uuid().optional(),
  ...OFFER_FIELD_SCHEMA,
});
const updateSchema = z.strictObject(OFFER_FIELD_SCHEMA);
/** 转移状态表单（34 §2.1）：目标状态 + 接受时间 / 拒绝时间、原因、备注；必填按目标在领域规则里判。 */
const transferSchema = z.strictObject({
  target: z.enum(OFFER_STATUSES),
  acceptTime: day,
  refusalTime: day,
  refusalReasonCode: text(100),
  refusalRemark: text(500),
  /** 超编弱控二次确认标记（OF-R10）：目标为已接受且录用部门超编时，前端确认后带它重提。 */
  confirmed: z.boolean().optional(),
});
/** 失效表单（OF-R7）：原因走字典、备注选填。 */
const invalidateSchema = z.strictObject({ reasonCode: text(100), remark: text(500) });
/** 发送 / 重发（OF-R5）：抄送、密送各最多 10 个邮箱；超编确认标记同转移。模板与附件首版没有，不收。 */
const emails = z.array(z.email().max(200)).max(10).optional();
const sendSchema = z.strictObject({ cc: emails, bcc: emails, confirmed: z.boolean().optional() });
export type OfferSendInput = z.infer<typeof sendSchema>;
export type OfferCreateInput = z.infer<typeof createSchema>;
export type OfferTransferInput = z.infer<typeof transferSchema>;
export type OfferInvalidateInput = z.infer<typeof invalidateSchema>;
export type OfferUpdateInput = z.infer<typeof updateSchema>;

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Offer 字段不合法', parsed.error.issues);
  return parsed.data;
}

export const parseOfferCreate = (raw: unknown) => parse(createSchema, raw);
export const parseOfferUpdate = (raw: unknown) => parse(updateSchema, raw);
export const parseOfferTransfer = (raw: unknown) => parse(transferSchema, raw);
export const parseOfferSend = (raw: unknown) => parse(sendSchema, raw);
export const parseOfferInvalidate = (raw: unknown) => parse(invalidateSchema, raw);
