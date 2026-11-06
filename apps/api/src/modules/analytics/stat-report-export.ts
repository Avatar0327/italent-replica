/**
 * 统计报表 xlsx 导出的公共出口（F-482，DEC-803②、DEC-809）：校验下载方式、取导出人姓名与租户当天日期、排版、
 * 写“一次导出一条”的对象操作日志，再把文件交给客户端。
 * 复刻口径（原站未测）：导出与页面同一份数据、同一套权限与数据范围裁剪，即“能看就能导出”，不新增授权项；
 * 文件写完整后才记日志，日志写入失败则整个请求失败、不放出文件（失败的导出不留成功记录）。
 */
import { getUser, withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { Context } from 'hono';
import { recordOperationLog } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import type { objectContext } from '../permission/module-route-access.js';
import type { ExportStamp } from './stat-report-layout.js';
import { attachmentHeader, statWorkbook, type ExportMode, type StatSheet } from './stat-xlsx.js';

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** 写进日志附件的口径说明：导出是按复刻口径实现的，原站没有测过它的审计行为。 */
export const EXPORT_NOTE = '原站未测、按复刻口径实现';

/** mode 必填：data = 仅下载数据，formula = 下载（含公式）。 */
export function exportMode(c: Context): ExportMode {
  const mode = c.req.query('mode');
  if (mode !== 'data' && mode !== 'formula') throw new AppError('VALIDATION_FAILED', 'mode 只能是 data / formula');
  return mode;
}

export interface StatExport {
  readonly object: string;
  readonly reportCode: string;
  readonly fileName: string;
  readonly mode: ExportMode;
  /** 页面当前已运行的筛选（只作日志摘要；文件里只回显时间类条件，DEC-810①）。 */
  readonly filter: Readonly<Record<string, unknown>>;
  readonly layout: (stamp: ExportStamp) => StatSheet;
}

export async function exportStatReport(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  base: Awaited<ReturnType<typeof objectContext>>,
  job: StatExport,
) {
  const user = await getUser(deps.db, base.userId);
  const stamp: ExportStamp = {
    mode: job.mode,
    exporter: user?.displayName ?? '',
    today: tenantLocalDate(base.now, base.timezone),
  };
  const file = statWorkbook(job.layout(stamp));
  await withTenant(deps.db, base.tenantId, (tx) =>
    recordOperationLog(tx, {
      tenantId: base.tenantId,
      actorUserId: base.userId,
      behavior: 'export',
      objectType: job.object,
      objectId: job.reportCode,
      successCount: 1,
      failureCount: 0,
      summary: `导出${job.fileName.replace(/\.xlsx$/, '')}（${job.mode === 'formula' ? '含公式' : '仅数据'}）`,
      attachment: { fileName: job.fileName, mode: job.mode, filter: job.filter, note: EXPORT_NOTE },
      occurredAt: base.now,
    }),
  );
  c.header('Content-Type', XLSX_CONTENT_TYPE);
  c.header('Content-Disposition', attachmentHeader(job.fileName));
  c.header('Cache-Control', 'no-store');
  return c.body(new Uint8Array(file));
}
