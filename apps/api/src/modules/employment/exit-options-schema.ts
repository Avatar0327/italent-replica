/**
 * 离职申请请求体 exit 区块的 zod 模式（叶模块，F-512）：exitOptionsSchema / ExitOptions 原在 exit-initiation.ts。
 * exit-application 在顶层 exitOptionsSchema.omit(...) 派生补丁模式；exit-initiation 位于“审批引擎 ↔ 任职上下文”的导入环上，
 * 以它为首个入口时 exit-application 先于它求值，顶层读到 undefined。本文件只依赖 zod / domain / 非环上的 fields、org，
 * 不在环上。exit-initiation 对原名再导出。
 */
import { BLACKLIST_NOTE_MAX, BLACKLIST_REASON_CODES, EXIT_FORM_DUTY_TRANSFER_TIMINGS } from '@italent/domain';
import { z } from 'zod';
import { validIsoDate } from '../org/read-model.js';
import { normalizedUuid } from './fields.js';

const code = z.string().trim().min(1).max(100);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const realDay = day.refine(validIsoDate, '日期必须为合法 YYYY-MM-DD');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** 请求体里的 exit 区块（通用入口与专用入口同形）；不含 initiation：HTTP 入口的发起方式由路由固定。 */
export const exitOptionsSchema = z.strictObject({
  reasonCode: code.optional(),
  whereaboutsCode: code.optional(),
  exitTypeCode: code.optional(),
  attachmentRefs: z.array(normalizedUuid).max(20).optional(),
  handoverEmployeeId: normalizedUuid.optional(),
  addToBlacklist: z.boolean().optional(),
  /** 加黑三项（DM-R2）：只在 addToBlacklist 时可填；有效截止日期空 = 永久，原因必填，说明与黑名单页一致 ≤500 字。 */
  blacklistExpiryDate: realDay.nullable().optional(),
  blacklistReason: z.enum(BLACKLIST_REASON_CODES).optional(),
  blacklistNote: z.string().trim().max(BLACKLIST_NOTE_MAX).nullable().optional(),
  compensationAmount: z.number().min(0).max(1e11).optional(),
  nonCompeteAmount: z.number().min(0).max(1e11).optional(),
  lastPayDate: day.optional(),
  socialInsuranceEndMonth: month.optional(),
  annualLeaveSettled: z.boolean().optional(),
  taxPeriod: month.optional(),
  taxYear: z.int().min(1900).max(9999).optional(),
  employerName: z.string().trim().min(1).max(200).optional(),
  actualLeaveDate: day.optional(),
  /** 本单的职责转交时机（R2-T09b DT-R3）：不填取租户配置；指定日期必须带 dutyTransferDate。 */
  dutyTransferTiming: z.enum(EXIT_FORM_DUTY_TRANSFER_TIMINGS).optional(),
  dutyTransferDate: realDay.optional(),
  /** 职责转交计划（§5.7）：结构由 transfer/linkage/input.ts 的 normalizeLinkage 校验，只允许 dutyTransfer 区块。 */
  dutyTransfer: z.unknown().optional(),
  /** §8 在途调动确认令牌。 */
  pendingTransferAck: z.string().max(200).optional(),
});
export type ExitOptions = z.infer<typeof exitOptionsSchema>;
