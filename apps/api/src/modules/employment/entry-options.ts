/**
 * 入职业务的服务端控制项（R2 BE-2a，EntryOptions 的路由接线；15 §9.3）：
 * pendingEntry = 添加待入职，probation = 是否有试用期，probationMonths / probationEndDate = 试用期（月）与手填的预计试用结束日
 * （BE-3，R2e6）。像 loginEmail 一样从请求体里单独取出，不进入任职字段校验，也不能用来直接写人员状态 / 入职状态；
 * 只允许入职类业务。待入职时只记是否有试用期（F-188），月数在办理入职时填；直接入职写试用期版本链（entry-probation.ts）。
 */
import { PROBATION_MONTHS_MAX, PROBATION_MONTHS_MIN } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { EntryOptions } from './employee-status.js';
import { NEW_CYCLE_KINDS } from './write-service.js';
import type { NormalizedEmploymentInput } from './types.js';

/** 试用期月数与手填的预计结束日（BE-3）：直接入职、办理入职共用。 */
export const probationTerms = {
  probationMonths: z.int().min(PROBATION_MONTHS_MIN).max(PROBATION_MONTHS_MAX).optional(),
  probationEndDate: z.iso.date().optional(),
};
const entryControls = z.strictObject({
  pendingEntry: z.boolean().optional(),
  probation: z.boolean().optional(),
  ...probationTerms,
});
const KEYS = ['pendingEntry', 'probation', 'probationMonths', 'probationEndDate'] as const;

export function splitEntryOptions(body: unknown): { rawInput: unknown; entry: EntryOptions | undefined } {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !KEYS.some((key) => key in body))
    return { rawInput: body, entry: undefined };
  const source = body as Record<string, unknown>;
  const picked = Object.fromEntries(KEYS.filter((key) => key in source).map((key) => [key, source[key]]));
  const parsed = entryControls.safeParse(picked);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '入职控制项不合法', parsed.error.issues);
  assertProbationTerms(parsed.data);
  const rawInput = Object.fromEntries(Object.entries(source).filter(([key]) => !KEYS.some((k) => k === key)));
  return { rawInput, entry: parsed.data };
}

/** 月数 / 预计结束日只跟“有试用期”一起出现（办理入职的请求体同样适用）。 */
export function assertProbationTerms(entry: EntryOptions): void {
  const terms = entry.probationMonths !== undefined || entry.probationEndDate !== undefined;
  if (terms && entry.probation !== true)
    throw new AppError('VALIDATION_FAILED', '只有有试用期时才能填写试用期月数和预计试用结束日期', {
      reason: 'PROBATION_TERMS_WITHOUT_PROBATION',
    });
}

export function assertEntryOptionsAllowed(input: NormalizedEmploymentInput, entry: EntryOptions | undefined): void {
  if (!entry) return;
  if (!NEW_CYCLE_KINDS.includes(input.kind))
    throw new AppError('VALIDATION_FAILED', '只有入职类业务可以提供待入职 / 是否有试用期');
  const terms = entry.probationMonths !== undefined || entry.probationEndDate !== undefined;
  // 入职申请审批期间还可能改期，开始日要到生效时才定：申请只记是否有试用期，月数等入职生效后经调整试用信息填写
  if (terms && input.mode !== 'direct')
    throw new AppError('VALIDATION_FAILED', '入职申请只记录是否有试用期，试用期月数在入职生效后调整试用信息时填写', {
      reason: 'PROBATION_TERMS_APPLICATION',
    });
  if (!entry.pendingEntry) return;
  if (terms)
    throw new AppError('VALIDATION_FAILED', '待入职只记录是否有试用期，试用期月数在办理入职时填写', {
      reason: 'PROBATION_TERMS_PENDING',
    });
  // 待入职阶段可选带 probation，随待入职记录落库（F-188）；Offer 同步来的待入职没有值，原站在编辑时才要求补填
  if (input.mode !== 'direct') throw new AppError('VALIDATION_FAILED', '待入职只能直接添加，不走入职申请');
}
