/**
 * 入职业务的两个服务端控制项（R2 BE-2a，EntryOptions 的路由接线；15 §9.3）：
 * pendingEntry = 添加待入职，probation = 是否有试用期。像 loginEmail 一样从请求体里单独取出，不进入任职字段校验，
 * 也不能用来直接写人员状态 / 入职状态；只允许入职类业务。待入职时 probation 落到 entry-probation.ts（F-188）。
 */
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { EntryOptions } from './employee-status.js';
import { NEW_CYCLE_KINDS } from './write-service.js';
import type { NormalizedEmploymentInput } from './types.js';

const entryControls = z.strictObject({ pendingEntry: z.boolean().optional(), probation: z.boolean().optional() });
const KEYS = ['pendingEntry', 'probation'] as const;

export function splitEntryOptions(body: unknown): { rawInput: unknown; entry: EntryOptions | undefined } {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !KEYS.some((key) => key in body))
    return { rawInput: body, entry: undefined };
  const source = body as Record<string, unknown>;
  const picked = Object.fromEntries(KEYS.filter((key) => key in source).map((key) => [key, source[key]]));
  const parsed = entryControls.safeParse(picked);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'pendingEntry / probation 必须为布尔值');
  const rawInput = Object.fromEntries(Object.entries(source).filter(([key]) => !KEYS.some((k) => k === key)));
  return { rawInput, entry: parsed.data };
}

export function assertEntryOptionsAllowed(input: NormalizedEmploymentInput, entry: EntryOptions | undefined): void {
  if (!entry) return;
  if (!NEW_CYCLE_KINDS.includes(input.kind))
    throw new AppError('VALIDATION_FAILED', '只有入职类业务可以提供待入职 / 是否有试用期');
  if (!entry.pendingEntry) return;
  // 待入职阶段可选带 probation，随待入职记录落库（F-188）；Offer 同步来的待入职没有值，原站在编辑时才要求补填
  if (input.mode !== 'direct') throw new AppError('VALIDATION_FAILED', '待入职只能直接添加，不走入职申请');
}
