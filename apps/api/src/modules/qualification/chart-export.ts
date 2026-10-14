/** C1-7 图谱导出（QL-R12；设计 §5.1 / §5.3）：只读下载，没有任务、缓存或命令台账。 */
import { isUuid, sql, withTenant, type Tx } from '@italent/db';
import type { Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { accessSql, qualificationContext, qualificationScope, requireReadable, rowsOf } from './access.js';
import { loadChart } from './chart.js';
import { boundedSize, chartWorkbook, exportLimit, MAX_EXPORT_ROWS, zipFiles } from './chart-files.js';
import { presentChart } from './presenters.js';
import { QL_BASE } from './route-support.js';
import { rowAccess } from './store.js';

const MAX_CATEGORIES = 20;

function categoryIds(value: string | undefined) {
  const ids = value?.split(',') ?? [];
  if (ids.length > MAX_CATEGORIES) throw exportLimit('EXPORT_CATEGORY_LIMIT', '一次最多导出 20 个类别');
  if (!ids.length || ids.some((id) => !isUuid(id))) throw new AppError('VALIDATION_FAILED', '类别标识必须为 UUID');
  const normalized = ids.map((id) => id.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw new AppError('VALIDATION_FAILED', '类别不可重复选择');
  return normalized;
}

/** 在加载嵌套明细前按实体行计数，避免先 materialize 无限结果再检查；文件组装另检查实际工作表行数与字节。 */
async function requireBoundedRows(tx: Tx, tenantId: string, ids: readonly string[]) {
  const selected = sql`tenant_id = ${tenantId}::uuid AND standard_id = ANY(${`{${ids.join(',')}}`}::uuid[])`;
  const counts = rowsOf<{ count: number }>(
    await tx.execute(sql`SELECT
    (SELECT COALESCE(sum(cardinality(level_ids)), 0) FROM ql_standards
      WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${`{${ids.join(',')}}`}::uuid[])) +
    (SELECT count(*) FROM ql_standard_details WHERE ${selected}) +
    (SELECT count(*) FROM ql_level_descriptions WHERE ${selected}) +
    (SELECT count(*) FROM ql_ability_details a JOIN ql_standard_details d
      ON d.tenant_id = a.tenant_id AND d.id = a.detail_id
      WHERE d.tenant_id = ${tenantId}::uuid AND d.standard_id = ANY(${`{${ids.join(',')}}`}::uuid[])) AS count`),
  );
  if (Number(counts[0]!.count) > MAX_EXPORT_ROWS) throw exportLimit('EXPORT_ROW_LIMIT', '导出最多 10000 条图谱数据行');
}

export function registerChartExport(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${QL_BASE}/chart-export`, async (c) => {
    const ctx = await qualificationContext(c, deps, 'standard');
    const ids = categoryIds(c.req.query('categoryIds'));
    const scope = await qualificationScope(c, deps, ctx, 'standard');
    const loaded = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const categories = rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT t.id FROM ql_categories t
        WHERE t.tenant_id = ${ctx.tenantId}::uuid AND t.id = ANY(${`{${ids.join(',')}}`}::uuid[])
          AND ${accessSql(ctx, scope, 'open').readable}`),
      );
      // DEC-352：类别与标准读取开放；保留同读取谓词，跨租户与不存在统一，绝不部分返回。
      if (categories.length !== ids.length) throw new AppError('NOT_FOUND', '任职类别不存在');
      const standards = rowsOf<{ id: string; category_id: string }>(
        await tx.execute(sql`SELECT t.id, t.category_id
        FROM ql_standards t WHERE t.tenant_id = ${ctx.tenantId}::uuid
          AND t.category_id = ANY(${`{${ids.join(',')}}`}::uuid[])
          AND ${accessSql(ctx, scope, 'standard').readable} ORDER BY t.id FOR SHARE`),
      );
      await requireBoundedRows(
        tx,
        ctx.tenantId,
        standards.map((standard) => standard.id),
      );
      const charts = new Map<string, Awaited<ReturnType<typeof loadChart>>>();
      for (const standard of standards) {
        requireReadable((await rowAccess(tx, ctx, scope, 'standard', standard.id)).access, 'standard');
        charts.set(standard.category_id, await loadChart(tx, ctx, standard.id));
      }
      return charts;
    });
    const files = [];
    const budget = { rows: 0, bytes: 0 };
    let bytes = 0;
    for (const id of ids) {
      const chart = loaded.get(id);
      const shown = chart ? await presentChart(c, deps, ctx, chart.standard, chart.orders) : { levels: [] };
      const data = chartWorkbook(shown, budget);
      bytes += data.length;
      boundedSize(bytes);
      files.push({ name: `${id}.xlsx`, data });
    }
    const single = files.length === 1;
    c.header(
      'Content-Type',
      single ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/zip',
    );
    c.header('Content-Disposition', `attachment; filename="${single ? files[0]!.name : 'qualification-charts.zip'}"`);
    c.header('Cache-Control', 'no-store');
    return c.body(new Uint8Array(single ? files[0]!.data : zipFiles(files)));
  });
}
