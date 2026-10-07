/**
 * AC-EXP-* 共用：表达式引擎的计算上下文与内存端口替身（REQ-EXP-001，DEC-024）。
 * 引擎不读系统时钟：“今天”和时区由上下文传入（DEC-056）。
 */
import {
  createInMemoryPorts,
  inMemorySubject,
  type EvaluationContext,
  type InMemoryPortData,
  type PlainValue,
} from '@italent/domain';

export const CALENDAR = { today: '2026-10-06', timeZone: 'Asia/Shanghai' } as const;

/** 盘点项目时间：2026-09-01 ～ 2026-09-30（UTC 瞬时）。 */
export const PROJECT = {
  startAt: new Date('2026-08-31T16:00:00Z'),
  endAt: new Date('2026-09-29T16:00:00Z'),
} as const;

export function contextFor(
  fields: Record<string, PlainValue>,
  options: { ports?: InMemoryPortData; forbidden?: readonly string[]; subjectId?: string } = {},
): EvaluationContext {
  return {
    subject: inMemorySubject(options.subjectId ?? 'emp-1', fields, { forbidden: options.forbidden }),
    calendar: CALENDAR,
    project: PROJECT,
    ports: options.ports ? createInMemoryPorts(options.ports) : undefined,
  };
}
