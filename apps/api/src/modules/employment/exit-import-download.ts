/**
 * F-493 S3c 错误文件下载的编排（设计 §8.2、§8.3）：权限复核 → 找到“我提交的”批次 → 状态 / 到期判定 → 装配 xlsx →
 * 写一条 export 操作日志（同一租户事务，日志写不进就整个请求失败、不放出文件）。
 * 到期按 expires_at 判（数据库时间），不等清理任务跑完；他人 / 他租户的批次一律 404，不泄露存在性。
 */
import { exitImportBatches, and, eq, sql, withTenant } from '@italent/db';
import { recordOperationLog } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { EmploymentContext } from './context.js';
import {
  ERROR_FILE_NAME,
  errorWorkbook,
  loadErrorFileRows,
  requireExitImportDownloadAccess,
  viewableColumns,
} from './exit-import-file.js';
import { rowsOf } from './record-store.js';

const notFound = (code: string, message: string) => new AppError('NOT_FOUND', message, { reason: code });

export async function exitImportErrorFile(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  batchId: string,
): Promise<{ readonly fileName: string; readonly content: Buffer }> {
  await requireExitImportDownloadAccess(deps, ctx);
  const shown = await viewableColumns(deps, ctx);
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const [batch] = await tx
      .select({
        status: exitImportBatches.status,
        errorCount: exitImportBatches.errorCount,
        errorRowCount: exitImportBatches.errorRowCount,
      })
      .from(exitImportBatches)
      .where(
        and(
          eq(exitImportBatches.tenantId, ctx.tenantId),
          eq(exitImportBatches.id, batchId),
          eq(exitImportBatches.submittedBy, ctx.userId),
        ),
      );
    if (!batch) throw new AppError('NOT_FOUND', '导入批次不存在');
    if (batch.status !== 'completed' && batch.status !== 'failed')
      throw new AppError('CONFLICT', '导入尚未结束，请稍后再下载', { reason: 'EXIT_IMPORT_NOT_FINISHED' });
    const [expired] = rowsOf<{ expired: boolean }>(
      await tx.execute(sql`SELECT (expires_at IS NOT NULL AND expires_at <= now()) AS expired
        FROM exit_import_batches WHERE tenant_id=${ctx.tenantId} AND id=${batchId}::uuid`),
    );
    if (expired?.expired) throw notFound('EXIT_IMPORT_FILE_EXPIRED', '错误文件已过期（保留 15 天）');
    if (batch.errorCount === 0) throw notFound('EXIT_IMPORT_NO_ERROR_FILE', '该批次没有错误，无需下载错误文件');

    const content = errorWorkbook(await loadErrorFileRows(tx, ctx.tenantId, batchId), shown);
    await recordOperationLog(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      behavior: 'export',
      objectType: 'exit-import',
      objectId: batchId,
      successCount: batch.errorRowCount,
      failureCount: 0,
      summary: `下载历史离职导入错误报告（${batch.errorRowCount}行）`,
      attachment: { fileName: ERROR_FILE_NAME },
      occurredAt: ctx.now,
    });
    return { fileName: ERROR_FILE_NAME, content };
  });
}
