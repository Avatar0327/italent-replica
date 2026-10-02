import { isUuid, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { Context } from 'hono';
import type { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantContext, type TenantEnv } from '../../tenant-context.js';
import { validIsoDate } from '../org/read-model.js';

export interface BusinessContext extends TenantContext {
  readonly expectedRevision: number;
  readonly commandId: string;
  readonly now: Date;
}

export async function readContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  action: string,
  expectedRevision = 0,
): Promise<BusinessContext> {
  const tenant = tenantOf(c);
  await requirePermission(deps.authorize, { ...tenant, action });
  return { ...tenant, expectedRevision, commandId: '', now: deps.clock() };
}

/** 两个 T04 模块复用底座台账；指纹含 revision，失败时由底座回查原命令。 */
export async function runWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: BusinessContext,
  input: unknown,
  execute: (tx: Tx, ctx: BusinessContext) => Promise<CommandResult>,
) {
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input },
    execute: (tx, commandId) => execute(tx, { ...ctx, commandId }),
  });
  const payload = result.body as { revision?: number } | null;
  if (payload?.revision !== undefined) c.header('ETag', `"${payload.revision}"`);
  return c.json(result.body, result.status);
}

export function revision(c: Context): number {
  const match = /^(?:W\/)?"?(\d{1,9})"?$/.exec(c.req.header('if-match')?.trim() ?? '');
  if (!match) throw new AppError('REVISION_REQUIRED', '写请求必须在 If-Match 中携带 revision');
  return Number(match[1]);
}

export function requireNew(ctx: { readonly expectedRevision: number }): void {
  if (ctx.expectedRevision !== 0) throw new AppError('REVISION_CONFLICT', '新建对象的 revision 必须为 0');
}

export async function parseBody<T>(c: Context<TenantEnv>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '请求字段不合法', parsed.error.issues);
  return parsed.data;
}

export function queryDate(c: Context, ctx: BusinessContext): string {
  const asOf = c.req.query('asOf') ?? tenantLocalDate(ctx.now, ctx.timezone);
  if (!validIsoDate(asOf)) throw new AppError('VALIDATION_FAILED', '查询时点必须为合法日期');
  return asOf;
}

export function pageQuery(c: Context) {
  const page = queryInteger(c, 'page', 1, 1_000_000);
  const pageSize = queryInteger(c, 'pageSize', 50, 200);
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

function queryInteger(c: Context, name: string, fallback: number, maximum: number): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new AppError('VALIDATION_FAILED', `${name} 必须为正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AppError('VALIDATION_FAILED', `${name} 超出允许范围`);
  }
  return value;
}

export function uuidParam(c: Context, name = 'id'): string {
  const value = c.req.param(name) ?? '';
  if (!isUuid(value)) throw new AppError('VALIDATION_FAILED', '对象标识必须为 UUID');
  return value;
}
