/**
 * 职务职级图谱与待确认记录的 xlsx 导出（F-474-7c；设计 docs/08_设计/F-474-7a_职务职级图谱_设计.md §4.2、§5）。
 * 只读：每次从当前快照现生成，不写台账 / outbox / 审计，不落对象存储；每次请求先按五源对象重新授权，
 * 通过后才写响应头与文件字节（§4.4）。
 */
import { sql, withTenant } from '@italent/db';
import {
  JOB_GRAPH_TEXT as t,
  jobGraphGrid,
  jobGraphReasonText,
  type JobGraphLayout,
  type JobGraphReason,
} from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import {
  BORDERED,
  boundedRows,
  fillStyle,
  MAX_EXPORT_ROWS,
  styledWorkbook,
  type StyledCell,
} from '../qualification/chart-files.js';
import { issueFilter, issueWhere, readSnapshot } from './graph-routes.js';
import { requireGraphExport } from './graph-sources.js';
import { rowsOf } from './store.js';

const BASE = '/api/tenant/job/graph';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET = 'Sheet0';
const MAX_SELECTED = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 与页面同色（apps/web/src/job/job-graph.css，设计 §1 取证值）：顶行、表头、职等列、三种类别色轮换。 */
const FILLS = ['FFF0F2F5', 'FFFAFAFB', 'FFFFFFFF', 'FFEAF5FF', 'FFFEF8E5', 'FFF2FAE7'];
const [TOP, HEAD, GRADE, TYPE] = [0, 1, 2, 3].map(fillStyle) as [number, number, number, number];

/** 文件名取导出时刻的租户本地时间 yyyyMMddHHmmss（DEC-056），不用服务器时区。 */
function stamp(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  return ['year', 'month', 'day', 'hour', 'minute', 'second']
    .map((type) => parts.find((part) => part.type === type)?.value ?? '')
    .join('');
}

function download(c: Context, deps: TenantRouteDeps, prefix: string, data: Buffer) {
  const name = `${prefix}_${stamp(deps.clock(), tenantOf(c).timezone)}.xlsx`;
  c.header('Content-Type', XLSX);
  c.header('Content-Disposition', `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
  c.header('Cache-Control', 'no-store');
  return c.body(new Uint8Array(data));
}

/** 页面矩阵同一套格子；被合并覆盖的格也输出并沿用锚点样式，合并区四周边框完整。 */
export function graphSheet(layout: JobGraphLayout) {
  boundedRows(layout.rowGrades.length);
  const styleOf = (row: number, column: number, colorKey?: number) => {
    if (colorKey !== undefined) return TYPE + (colorKey % 3);
    if (row === 0) return TOP;
    if (row < layout.headerRows) return HEAD;
    return column === 0 ? GRADE : BORDERED;
  };
  const cells = new Map<string, StyledCell>();
  for (const cell of jobGraphGrid(layout).flat()) {
    const style = styleOf(cell.row, cell.column, cell.colorKey);
    for (let row = cell.row; row < cell.row + cell.rowSpan; row++)
      for (let column = cell.column; column < cell.column + cell.colSpan; column++)
        cells.set(`${row},${column}`, {
          row: row + 1,
          column: column + 1,
          text: row === cell.row && column === cell.column ? cell.text : '',
          style,
        });
  }
  const columns = 1 + Math.max(0, ...[...cells.values()].map((cell) => cell.column - 1));
  const rows = layout.headerRows + layout.rowGrades.length;
  return styledWorkbook({
    name: SHEET,
    fills: FILLS,
    rows: Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (_, column) => cells.get(`${row},${column}`)).filter((cell) => !!cell),
    ),
    merges: layout.merges.map((merge) => ({
      fromRow: merge.fromRow + 1,
      fromColumn: merge.fromColumn + 1,
      toRow: merge.toRow + 1,
      toColumn: merge.toColumn + 1,
    })),
  });
}

/** `ids`（逗号分隔，1～500 个对象 ID）与 `all=true` 二选一；all 沿用列表的类型 / 名称筛选。 */
function issueSelection(c: Context) {
  const ids = c.req.query('ids');
  const all = c.req.query('all');
  if ((ids === undefined) === (all === undefined) || (all !== undefined && all !== 'true'))
    throw new AppError('VALIDATION_FAILED', '请指定 ids 或 all=true 之一');
  if (all) return { ...issueFilter(c), ids: undefined };
  const list = ids!.split(',');
  if (list.length > MAX_SELECTED || !list.every((id) => UUID.test(id)))
    throw new AppError('VALIDATION_FAILED', `ids 须为 1～${MAX_SELECTED} 个对象 ID`);
  return { kind: undefined, name: undefined, ids: list };
}

export function registerGraphExportRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${BASE}/export`, async (c) => {
    const ctx = tenantOf(c);
    await requireGraphExport(deps, ctx);
    const snapshot = await withTenant(deps.db, ctx.tenantId, (tx) => readSnapshot(tx, ctx.tenantId));
    // DEC-896 U4 = A：无快照不现算，提示先生成
    if (!snapshot) throw new AppError('CONFLICT', '请先重新生成图谱', { reason: 'GRAPH_NOT_GENERATED' });
    return download(c, deps, '职务职级图谱', graphSheet(snapshot.layout as JobGraphLayout));
  });

  router.get(`${BASE}/issues/export`, async (c) => {
    const ctx = tenantOf(c);
    await requireGraphExport(deps, ctx);
    const { kind, name, ids } = issueSelection(c);
    const where = sql`${issueWhere(ctx.tenantId, kind, name)}
      ${
        ids
          ? sql`AND object_id::text IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``
      }`;
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const [count] = rowsOf<{ total: number }>(
        await tx.execute(sql`SELECT count(*)::int AS total FROM job_graph_issues WHERE ${where}`),
      );
      boundedRows(count?.total ?? 0);
      return rowsOf<{ kind: string; objectName: string; reasons: JobGraphReason[] }>(
        await tx.execute(sql`SELECT kind, object_name AS "objectName", reasons FROM job_graph_issues
          WHERE ${where} ORDER BY sort_key, id LIMIT ${MAX_EXPORT_ROWS}`),
      );
    });
    const header = [t.kind, t.name, t.reason];
    const rows = [
      header,
      ...items.map((item) => [t.kinds[item.kind] ?? '', item.objectName, jobGraphReasonText(item.reasons)]),
    ];
    return download(
      c,
      deps,
      '待确认的职务职级记录',
      styledWorkbook({
        name: SHEET,
        fills: [],
        rows: rows.map((values, row) => values.map((text, column) => ({ row: row + 1, column: column + 1, text }))),
      }),
    );
  });
}
