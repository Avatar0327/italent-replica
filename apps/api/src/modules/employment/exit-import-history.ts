/**
 * F-493 S3d 导入历史列表（设计 §8.4）：只列“我提交的”批次，按提交时间倒序，每页 15 条。
 * 对外只给三态（执行中 / 成功 / 失败）与展示用计数，不出行数据、内部计数、尝试次数与最后错误。
 * 提交人姓名走 tenant_member_accounts（租户内成员目录函数，users 表对租户角色不可读）。
 * 过期（filesExpired）按 expires_at 与数据库时间判，不等清理任务跑完；批次本身不随文件过期而消失。
 */
import { sql, withTenant } from '@italent/db';
import { EXIT_IMPORT_HISTORY_PAGE_SIZE } from '@italent/domain';
import type { Context } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { EmploymentContext } from './context.js';
import { businessDate } from './fields.js';
import { rowsOf } from './record-store.js';

export type ExitImportHistoryStatus = 'running' | 'succeeded' | 'failed';
const STATUSES: readonly ExitImportHistoryStatus[] = ['running', 'succeeded', 'failed'];
/** 对外三态 → 批次表里的内部状态（queued / running 都是“执行中”）。 */
const INTERNAL: Readonly<Record<ExitImportHistoryStatus, readonly string[]>> = {
  running: ['queued', 'running'],
  succeeded: ['completed'],
  failed: ['failed'],
};

export interface ExitImportHistoryQuery {
  readonly page: number;
  readonly statuses: readonly ExitImportHistoryStatus[];
  readonly from?: string;
  readonly to?: string;
}

export interface ExitImportHistoryItem {
  readonly id: string;
  readonly importType: 'exit';
  readonly createdAt: string;
  readonly submitterName: string;
  readonly status: ExitImportHistoryStatus;
  readonly total: number;
  /** 执行中为 null（尚无结论）。 */
  readonly errorCount: number | null;
  readonly hasErrorFile: boolean;
  readonly fileName: string;
  readonly filesExpired: boolean;
}

const invalid = (message: string) => new AppError('VALIDATION_FAILED', message);

/** 解析 page / status / from / to；非法一律 400，不静默纠正。 */
export function parseExitImportHistoryQuery(c: Context): ExitImportHistoryQuery {
  const rawPage = c.req.query('page');
  let page = 1;
  if (rawPage !== undefined) {
    page = /^\d+$/.test(rawPage) ? Number(rawPage) : 0;
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw invalid('page 必须为正整数');
  }
  const rawStatus = c.req.query('status');
  const statuses = rawStatus === undefined || rawStatus === '' ? [] : rawStatus.split(',');
  for (const status of statuses)
    if (!STATUSES.includes(status as ExitImportHistoryStatus))
      throw invalid('status 只能是 running / succeeded / failed');
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (from !== undefined) businessDate(from);
  if (to !== undefined) businessDate(to);
  if (from !== undefined && to !== undefined && from > to) throw invalid('起始日期不能晚于结束日期');
  return { page, statuses: statuses as ExitImportHistoryStatus[], from, to };
}

const publicStatus = (internal: string): ExitImportHistoryStatus =>
  internal === 'completed' ? 'succeeded' : internal === 'failed' ? 'failed' : 'running';

export async function listExitImportHistory(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  query: ExitImportHistoryQuery,
): Promise<{ items: ExitImportHistoryItem[]; page: number; hasNext: boolean }> {
  const internal = [...new Set(query.statuses.flatMap((status) => INTERNAL[status]))];
  const conditions = [sql`b.tenant_id = ${ctx.tenantId}::uuid`, sql`b.submitted_by = ${ctx.userId}::uuid`];
  if (internal.length)
    conditions.push(
      sql`b.status IN (${sql.join(
        internal.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  // 业务日期按租户时区含两端：[from 当天 0 点, to 次日 0 点)
  if (query.from) conditions.push(sql`b.created_at >= (${query.from}::date)::timestamp AT TIME ZONE ${ctx.timezone}`);
  if (query.to) conditions.push(sql`b.created_at < (${query.to}::date + 1)::timestamp AT TIME ZONE ${ctx.timezone}`);
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    // 多取 1 条判断 hasNext，不数总数；走索引 exit_import_batches_own_list
    const rows = rowsOf<{
      id: string;
      created_at: Date | string;
      status: string;
      total: number;
      error_count: number;
      file_name: string;
      submitter_name: string | null;
      expired: boolean;
    }>(
      await tx.execute(sql`
        SELECT b.id, b.created_at, b.status, b.total, b.error_count, b.file_name,
          (SELECT a.display_name FROM tenant_member_accounts(ARRAY[b.submitted_by]) a LIMIT 1) AS submitter_name,
          (b.purged_at IS NOT NULL OR (b.expires_at IS NOT NULL AND b.expires_at <= now())) AS expired
        FROM exit_import_batches b
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT ${EXIT_IMPORT_HISTORY_PAGE_SIZE + 1} OFFSET ${(query.page - 1) * EXIT_IMPORT_HISTORY_PAGE_SIZE}`),
    );
    const items = rows.slice(0, EXIT_IMPORT_HISTORY_PAGE_SIZE).map((row): ExitImportHistoryItem => {
      const status = publicStatus(row.status);
      const finished = status !== 'running';
      return {
        id: row.id,
        importType: 'exit',
        createdAt: new Date(row.created_at).toISOString(),
        submitterName: row.submitter_name ?? '',
        status,
        total: row.total,
        errorCount: finished ? row.error_count : null,
        hasErrorFile: finished && row.error_count >= 1,
        fileName: row.file_name,
        filesExpired: row.expired,
      };
    });
    return { items, page: query.page, hasNext: rows.length > EXIT_IMPORT_HISTORY_PAGE_SIZE };
  });
}
