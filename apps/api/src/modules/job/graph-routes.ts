/**
 * 职务职级图谱后端（F-474-7b；设计 docs/08_设计/F-474-7a_职务职级图谱_设计.md §3、§4.2）。
 * 图谱是派生缓存：GET 只读快照，不触发生成；POST /graph/rebuild 同步生成，同事务替换快照与待确认记录并写审计。
 * 五源对象的整体校验见 graph-sources.ts。
 */
import { sql, type Tx, withTenant } from '@italent/db';
import { buildJobGraph, JobGraphLimitError, tenantLocalDate, type JobGraphResult } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { asUuid, tryAdvisoryLock } from '../../advisory-lock.js';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { parseBody, revision, type BusinessContext } from './context.js';
import { GRAPH_OBJECT, loadGraphInput, requireGraphAccess, requireGraphRebuild } from './graph-sources.js';
import { lockJobTenant } from './settings.js';
import { auditJob, rowsOf } from './store.js';

const BASE = '/api/tenant/job/graph';
const ISSUE_KINDS = ['level', 'post'];

interface Snapshot {
  readonly revision: number;
  readonly asOfDate: string;
  readonly empty: boolean;
  readonly containsError: boolean;
  readonly issueCount: number;
  readonly generatedAt: string;
  readonly layout: unknown;
}

export async function readSnapshot(tx: Tx, tenantId: string): Promise<Snapshot | null> {
  const [row] = rowsOf<Snapshot & { generatedAt: Date | string }>(
    await tx.execute(sql`
    SELECT revision, as_of_date::text AS "asOfDate", empty, contains_error AS "containsError",
      issue_count AS "issueCount", generated_at AS "generatedAt", layout
    FROM job_graph_snapshots WHERE tenant_id = ${tenantId}`),
  );
  return row ? { ...row, generatedAt: new Date(row.generatedAt).toISOString() } : null;
}

async function replaceIssues(tx: Tx, tenantId: string, result: JobGraphResult) {
  await tx.execute(sql`DELETE FROM job_graph_issues WHERE tenant_id = ${tenantId}`);
  if (!result.issues.length) return;
  const rows = result.issues.map((issue, sortKey) => ({
    kind: issue.kind,
    object_id: issue.objectId,
    object_name: issue.objectName,
    reasons: issue.reasons,
    sort_key: sortKey,
  }));
  await tx.execute(sql`
    INSERT INTO job_graph_issues (tenant_id, kind, object_id, object_name, reasons, sort_key)
    SELECT ${tenantId}::uuid, x.kind, x.object_id::uuid, x.object_name, x.reasons, x.sort_key
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS x(kind text, object_id text, object_name text, reasons jsonb, sort_key int)`);
}

function generate(input: Parameters<typeof buildJobGraph>[0]): JobGraphResult {
  try {
    return buildJobGraph(input);
  } catch (error) {
    // 超限整单拒绝，机器可读原因放 details.reason（设计 §4.2）
    if (error instanceof JobGraphLimitError)
      throw new AppError('VALIDATION_FAILED', '职务职级数据超出图谱生成上限', { reason: error.code });
    throw error;
  }
}

/** 同租户同时只允许一个生成；If-Match 是当前快照 revision（无快照为 0）。 */
async function rebuild(tx: Tx, ctx: BusinessContext): Promise<CommandResult> {
  if (!(await tryAdvisoryLock(tx, 'job-graph:', asUuid(ctx.tenantId))))
    throw new AppError('CONFLICT', '图谱正在生成，请稍后刷新', { reason: 'GRAPH_GENERATING' });
  await lockJobTenant(tx, ctx);
  const current = await readSnapshot(tx, ctx.tenantId);
  const before = current?.revision ?? 0;
  if (before !== ctx.expectedRevision) throw new AppError('REVISION_CONFLICT', '图谱已被他人更新，请刷新后重提');
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  // 原生 sql 模板在真 PG 驱动下不能直接绑 Date，按 ISO 文本绑定
  const generatedAt = ctx.now.toISOString();
  const result = generate(await loadGraphInput(tx, ctx.tenantId, asOf));
  const values = {
    layout: JSON.stringify(result.layout),
    issues: result.issues.length,
    error: result.issues.length > 0,
  };
  if (current) {
    await tx.execute(sql`UPDATE job_graph_snapshots SET revision = ${before + 1},
      generated_at = ${generatedAt}::timestamptz, generated_by = ${ctx.userId}, as_of_date = ${asOf}::date,
      contains_error = ${values.error}, empty = ${result.empty}, issue_count = ${values.issues},
      layout = ${values.layout}::jsonb
      WHERE tenant_id = ${ctx.tenantId}`);
  } else {
    await tx.execute(sql`INSERT INTO job_graph_snapshots (tenant_id, revision, generated_at, generated_by,
      as_of_date, contains_error, empty, issue_count, layout)
      VALUES (${ctx.tenantId}, 1, ${generatedAt}::timestamptz, ${ctx.userId}, ${asOf}::date,
      ${values.error}, ${result.empty}, ${values.issues}, ${values.layout}::jsonb)`);
  }
  await replaceIssues(tx, ctx.tenantId, result);
  // 审计只记摘要，不写整份 layout（设计 §4.2）
  await auditJob(
    tx,
    ctx,
    'job.graph.rebuild',
    GRAPH_OBJECT.replace('TenantBase.', ''),
    ctx.tenantId,
    { revision: before },
    {
      revision: before + 1,
      issueCount: values.issues,
      containsError: values.error,
      empty: result.empty,
      asOfDate: asOf,
    },
  );
  return { status: 200, body: await readSnapshot(tx, ctx.tenantId) };
}

function queryInteger(c: Context, name: string, fallback: number, maximum: number): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : 0;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new AppError('VALIDATION_FAILED', `${name} 超出允许范围`);
  return value;
}

/** 类型 / 名称筛选：列表与“导出全部”同一口径（graph-export.ts）。 */
export function issueFilter(c: Context) {
  const kind = c.req.query('kind');
  if (kind !== undefined && !ISSUE_KINDS.includes(kind)) throw new AppError('VALIDATION_FAILED', 'kind 不合法');
  const name = c.req.query('name')?.trim();
  if (name !== undefined && name.length > 100) throw new AppError('VALIDATION_FAILED', 'name 过长');
  return { kind, name: name || undefined };
}

export const issueWhere = (tenantId: string, kind?: string, name?: string) => sql`tenant_id = ${tenantId}
  ${kind ? sql`AND kind = ${kind}` : sql``}
  ${name ? sql`AND position(lower(${name}) in lower(object_name)) > 0` : sql``}`;

function issueQuery(c: Context) {
  const page = queryInteger(c, 'page', 1, 1_000_000);
  const pageSize = queryInteger(c, 'pageSize', 15, 100);
  return { ...issueFilter(c), page, pageSize };
}

export function registerGraphRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(BASE, async (c) => {
    const ctx = tenantOf(c);
    await requireGraphAccess(deps, ctx);
    const snapshot = await withTenant(deps.db, ctx.tenantId, (tx) => readSnapshot(tx, ctx.tenantId));
    return c.json({ snapshot });
  });

  router.get(`${BASE}/issues`, async (c) => {
    const ctx = tenantOf(c);
    await requireGraphAccess(deps, ctx);
    const { kind, name, page, pageSize } = issueQuery(c);
    const where = issueWhere(ctx.tenantId, kind, name);
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const [count] = rowsOf<{ total: number }>(
          await tx.execute(sql`SELECT count(*)::int AS total FROM job_graph_issues WHERE ${where}`),
        );
        const items = rowsOf<object>(
          await tx.execute(sql`SELECT kind, object_id AS "objectId", object_name AS "objectName", reasons
          FROM job_graph_issues WHERE ${where} ORDER BY sort_key, id
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`),
        );
        return { items, total: count?.total ?? 0, page, pageSize };
      }),
    );
  });

  router.post(`${BASE}/rebuild`, async (c) => {
    const tenant = tenantOf(c);
    await requireGraphRebuild(deps, tenant);
    const expectedRevision = revision(c);
    await parseBody(c, z.strictObject({}));
    const ctx: BusinessContext = { ...tenant, expectedRevision, commandId: '', now: deps.clock() };
    const result = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { method: c.req.method, path: c.req.path, expectedRevision, input: {} },
      // 重放（含撤权后）在返回台账里的旧快照前，按当前身份、范围和字段权限再查一遍
      guard: { before: (tx) => requireGraphRebuild(deps, tenant, tx) },
      execute: (tx, commandId) => rebuild(tx, { ...ctx, commandId }),
    });
    c.header('ETag', `"${(result.body as Snapshot).revision}"`);
    return c.json(result.body, result.status);
  });
}
