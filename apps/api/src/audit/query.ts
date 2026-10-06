/**
 * 审计查询的公共部分：查询窗口（租户保留期，20 §2 / §5 第 4 条）、游标分页、操作人显示名。
 * 查询只读本租户（withTenant + RLS）；操作人姓名经迁移 0033 的受限定义者函数 tenant_member_accounts 读取，
 * 只回答本租户成员的账号，不经过平台用户表。
 */
import { isUuid, PLATFORM_SOURCE_ACTION, sql, type Tx } from '@italent/db';
import {
  auditQueryWindow,
  type AuditRetention,
  isIsoDate,
  type IsoDate,
  resolveAuditRetention,
  tenantLocalDate,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { AppError } from '../errors.js';
import { readEffectiveSetting } from '../modules/tenant-settings/service.js';

export const RETENTION_KEY = 'audit.retention';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface AuditWindowBounds {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly earliest: IsoDate;
}

export async function tenantRetention(tx: Tx, tenantId: string): Promise<AuditRetention> {
  const setting = await readEffectiveSetting(tx, tenantId, RETENTION_KEY);
  return resolveAuditRetention(setting.value);
}

/** 按租户保留期校验查询窗口；越界返回 400 并带机器可读原因与最早可查日期。 */
export function queryWindow(c: Context, now: Date, timezone: string, retention: AuditRetention): AuditWindowBounds {
  const date = (name: 'from' | 'to') => {
    const raw = c.req.query(name);
    if (raw !== undefined && !isIsoDate(raw)) throw new AppError('VALIDATION_FAILED', `${name} 须为 YYYY-MM-DD`);
    return raw;
  };
  const window = auditQueryWindow(tenantLocalDate(now, timezone), retention, { from: date('from'), to: date('to') });
  if (!window.ok) {
    throw new AppError('VALIDATION_FAILED', windowMessage(window.reason, retention), {
      reason: window.reason,
      earliest: window.earliest,
      queryMonths: retention.queryMonths,
      retainMonths: retention.retainMonths,
    });
  }
  return { from: window.from, to: window.to, earliest: window.earliest };
}

function windowMessage(reason: string, retention: AuditRetention): string {
  if (reason === 'AUDIT_BEYOND_RETENTION') return `最远只能查询 ${retention.retainMonths} 个月内的日志`;
  if (reason === 'AUDIT_QUERY_WINDOW_TOO_LONG') return `一次最多查询 ${retention.queryMonths} 个月的日志`;
  return '开始日期不能晚于结束日期';
}

/** 业务日期闭区间 → 事件时间（UTC）的半开区间，按租户时区换算（DEC-056）。 */
export function occurredWithin(column: SQL, window: { from: IsoDate; to: IsoDate }, timezone: string): SQL {
  return sql`${column} >= ((${window.from}::date)::timestamp AT TIME ZONE ${timezone})
    AND ${column} < ((${window.to}::date + 1)::timestamp AT TIME ZONE ${timezone})`;
}

export function notBefore(column: SQL, earliest: IsoDate, timezone: string): SQL {
  return sql`${column} >= ((${earliest}::date)::timestamp AT TIME ZONE ${timezone})`;
}

export function pageLimit(c: Context): number {
  const raw = c.req.query('limit');
  if (raw === undefined) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > MAX_LIMIT) {
    throw new AppError('VALIDATION_FAILED', `limit 须为 1～${MAX_LIMIT}`);
  }
  return value;
}

/** 游标是上一页最后一条的编号；按库里该行的原始时间（微秒精度）比较，不因毫秒截断漏行或重行。 */
export function cursorOf(c: Context): string | undefined {
  const raw = c.req.query('cursor');
  if (raw === undefined) return undefined;
  if (!isUuid(raw)) throw new AppError('VALIDATION_FAILED', '分页游标不合法');
  return raw;
}

export function afterCursor(table: SQL, occurredAt: SQL, id: SQL, cursor: string | undefined): SQL {
  if (!cursor) return sql`true`;
  return sql`(${occurredAt}, ${id}) < (SELECT anchor.occurred_at, anchor.id FROM ${table} anchor
    WHERE anchor.id = ${cursor}::uuid)`;
}

/** 多取一条判断是否还有下一页；按事件时间倒序、编号倒序稳定排序。 */
export function paginate<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

export interface AuditOperatorView {
  readonly userId: string | null;
  readonly name: string;
}

/** 操作人显示：系统任务（为空）显示“系统”；平台运营不是租户成员，显示“平台运营”。 */
export async function operatorNames(
  tx: Tx,
  rows: readonly { actorUserId: string | null; sourceAction?: string | null }[],
): Promise<(row: { actorUserId: string | null; sourceAction?: string | null }) => AuditOperatorView> {
  const ids = [...new Set(rows.map((row) => row.actorUserId).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (ids.length) {
    const list = sql`ARRAY[${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[]`;
    const result = await tx.execute(sql`SELECT account_id::text AS id, display_name AS name
      FROM tenant_member_accounts(${list})`);
    const found = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      id: string;
      name: string;
    }[];
    for (const row of found) names.set(row.id, row.name);
  }
  return (row) => {
    if (row.actorUserId === null) return { userId: null, name: '系统' };
    const name = names.get(row.actorUserId);
    if (name) return { userId: row.actorUserId, name };
    return { userId: row.actorUserId, name: row.sourceAction === PLATFORM_SOURCE_ACTION ? '平台运营' : '非本租户用户' };
  };
}

export function optionalQuery(c: Context, name: string, pattern: RegExp): string | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return undefined;
  if (!pattern.test(raw)) throw new AppError('VALIDATION_FAILED', `${name} 不合法`);
  return raw;
}

export function optionalUuid(c: Context, name: string): string | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return undefined;
  if (!isUuid(raw)) throw new AppError('VALIDATION_FAILED', `${name} 必须是 UUID`);
  return raw;
}
