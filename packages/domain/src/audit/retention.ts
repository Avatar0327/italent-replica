/**
 * 日志查询期与保留期（docs/02_业务建模/20 §2、§5 第 4 条；REQ-AUD-001 R5）。
 * 原站“一次最多查询最近 3 个月、最远只能查 6 个月内”；复刻版做成租户级配置 audit.retention
 * （系统预置 { queryMonths: 3, retainMonths: 6 }，租户可覆盖、可恢复，迁移 0003）。
 * 日期一律是租户时区的业务日期（DEC-056）；保留期按“业务日期减月数”算，月末按目标月最后一天截断。
 */
import type { IsoDate } from '../tenant-time.js';

export interface AuditRetention {
  readonly queryMonths: number;
  readonly retainMonths: number;
}

export const DEFAULT_AUDIT_RETENTION: AuditRetention = { queryMonths: 3, retainMonths: 6 };
/** 保留期上限 10 年：防止误配成“永不过期”之外的异常值；更久的留存应走导出备份（原站同样要求提前导出）。 */
export const MAX_AUDIT_RETAIN_MONTHS = 120;

/** 租户配置不合法（缺项、非整数、越界）时逐项回落到系统值，不因配置错误而放宽或收紧到异常值。 */
export function resolveAuditRetention(value: unknown, fallback: AuditRetention = DEFAULT_AUDIT_RETENTION) {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const months = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;
  const retainMonths = months(raw.retainMonths, MAX_AUDIT_RETAIN_MONTHS)
    ? (raw.retainMonths as number)
    : fallback.retainMonths;
  const queryMonths = months(raw.queryMonths, retainMonths)
    ? (raw.queryMonths as number)
    : Math.min(fallback.queryMonths, retainMonths);
  return { queryMonths, retainMonths } satisfies AuditRetention;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

/** 业务日期加减月数；目标月没有该日时取月末（与 PostgreSQL date ± interval 'n month' 一致）。 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const match = ISO_DATE.exec(date);
  if (!match) throw new RangeError(`不是合法的业务日期：${date}`);
  const total = Number(match[1]) * 12 + Number(match[2]) - 1 + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(Number(match[3]), lastDay);
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export type AuditWindowRejection = 'AUDIT_BEYOND_RETENTION' | 'AUDIT_QUERY_WINDOW_TOO_LONG' | 'AUDIT_INVALID_RANGE';

export type AuditWindow =
  | { readonly ok: true; readonly from: IsoDate; readonly to: IsoDate; readonly earliest: IsoDate }
  | { readonly ok: false; readonly reason: AuditWindowRejection; readonly earliest: IsoDate };

/**
 * 查询窗口（闭区间业务日期）：最早只能到“今天 − 保留月数”；一次跨度不超过查询月数；不传则查最近的查询月数。
 * 截止日晚于今天按今天算（未来没有日志）。
 */
export function auditQueryWindow(
  today: IsoDate,
  retention: AuditRetention,
  requested: { readonly from?: IsoDate | undefined; readonly to?: IsoDate | undefined } = {},
): AuditWindow {
  const earliest = addMonths(today, -retention.retainMonths);
  const to = requested.to === undefined || requested.to > today ? today : requested.to;
  const widest = addMonths(to, -retention.queryMonths);
  const from = requested.from ?? (widest < earliest ? earliest : widest);
  if (from > to) return { ok: false, reason: 'AUDIT_INVALID_RANGE', earliest };
  if (from < earliest) return { ok: false, reason: 'AUDIT_BEYOND_RETENTION', earliest };
  if (from < widest) return { ok: false, reason: 'AUDIT_QUERY_WINDOW_TOO_LONG', earliest };
  return { ok: true, from, to, earliest };
}
