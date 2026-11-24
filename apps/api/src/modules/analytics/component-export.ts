import { withTenant } from '@italent/db';
import { ROSTER_EXPORT_MAX_ROWS } from '@italent/domain';
import type { Context } from 'hono';
import { recordOperationLog } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { exportLimitResponse, rosterCsv } from '../hr-analysis/roster-csv.js';

export const COMPONENT_EXPORT_PAGE = { limit: ROSTER_EXPORT_MAX_ROWS, offset: 0 } as const;

export function validateComponentExportQuery(c: Context, allowed: readonly string[]) {
  const seen = new Set<string>();
  for (const key of new URL(c.req.url).searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key)) {
      throw new AppError('VALIDATION_FAILED', '下载查询包含不支持或重复的参数');
    }
    seen.add(key);
  }
}

interface Column {
  readonly key: string;
  readonly label: string;
}
interface ComponentResult {
  readonly total: number;
  readonly items: readonly Record<string, unknown>[];
}
interface ComponentFile {
  readonly board: string;
  readonly object: string;
  readonly component: { readonly code: string; readonly name: string };
  readonly asOf: string;
  readonly columns: readonly Column[];
}

export function componentCsv(columns: readonly Column[], items: ComponentResult['items']) {
  return rosterCsv(columns, items, (_key, value) =>
    Array.isArray(value) ? JSON.stringify(value) : String(value ?? ''),
  );
}

/** 契约 §4–5：调用方提供已授权的 D 行集与列。租户操作日志提交后，才允许交付文件。 */
export async function exportComponent(
  c: Context<TenantEnv>,
  deps: Pick<TenantRouteDeps, 'db'>,
  actor: { readonly tenantId: string; readonly userId: string; readonly now: Date },
  job: ComponentFile,
  result: ComponentResult,
) {
  if (result.total > ROSTER_EXPORT_MAX_ROWS) return exportLimitResponse(c, result.total);

  const file = componentCsv(job.columns, result.items);
  await withTenant(deps.db, actor.tenantId, (tx) =>
    recordOperationLog(tx, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      behavior: 'export',
      objectType: job.object,
      objectId: job.component.code,
      successCount: 1,
      failureCount: 0,
      summary: `导出组件明细：${job.component.name}`,
      occurredAt: actor.now,
    }),
  );
  const fileName = `${job.board}-${job.component.code}-${job.asOf}.csv`;
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${fileName}"`);
  c.header('Cache-Control', 'no-store');
  return c.body(file);
}
