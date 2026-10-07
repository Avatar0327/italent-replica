/**
 * 360 模块公共装配（R3-T03）：360 独立管理员身份（DEC-027）、写命令（幂等台账 + 审计同事务）与错误口径。
 * 360 的功能权限不走组织员工的身份对象权限，而是按 survey360_admins 判定；每次请求、每个命令事务内都重新读取
 * 当前身份与活动授权（AGENTS.md §10「权限」），幂等重放同样先经过当前校验。
 */
import { and, eq, pgErrorCode, survey360Admins, type Tx, withTenant } from '@italent/db';
import type { Context } from 'hono';
import { z } from 'zod';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError, type ErrorCode } from '../../errors.js';
import { recordAudit } from '../../audit/record.js';
import { auditActor } from '../../system-actor.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantContext, type TenantEnv } from '../../tenant-context.js';
import { revision } from '../job/context.js';

export type AdminRole = 'system' | 'advanced' | 'general';

export interface Admin {
  readonly id: string;
  readonly userId: string;
  readonly role: AdminRole;
}

export interface Survey360Context extends TenantContext {
  readonly now: Date;
  readonly commandId: string;
  readonly admin: Admin;
  readonly expectedRevision: number;
}

export type C = Context<TenantEnv>;

export function fail(code: ErrorCode, message: string, reason?: string, extra: Record<string, unknown> = {}): never {
  throw new AppError(code, message, reason ? { reason, ...extra } : undefined);
}

export function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

export async function loadAdmin(tx: Tx, userId: string): Promise<Admin | null> {
  const [row] = await tx
    .select({ id: survey360Admins.id, userId: survey360Admins.userId, role: survey360Admins.role })
    .from(survey360Admins)
    .where(and(eq(survey360Admins.userId, userId), eq(survey360Admins.status, 'active')));
  return row ? { ...row, role: row.role as AdminRole } : null;
}

/** 当前请求者的 360 管理员身份；不是 360 管理员一律 403（不区分资源是否存在）。 */
export async function requireAdmin(tx: Tx, userId: string, roles?: readonly AdminRole[]): Promise<Admin> {
  const admin = await loadAdmin(tx, userId);
  if (!admin) fail('FORBIDDEN', '不是 360 管理员');
  if (roles && !roles.includes(admin.role)) fail('FORBIDDEN', '当前 360 管理员身份无权执行该操作');
  return admin;
}

export const SYSTEM_ONLY: readonly AdminRole[] = ['system'];
export const SENIOR: readonly AdminRole[] = ['system', 'advanced'];

/** 读接口：在一个租户事务里校验身份后读取。guard 内抛出的 404 / 403 原样返回。 */
export async function read<T>(
  c: C,
  deps: TenantRouteDeps,
  load: (tx: Tx, admin: Admin, tenant: TenantContext) => Promise<T>,
  roles?: readonly AdminRole[],
): Promise<Response> {
  const tenant = tenantOf(c);
  const body = await withTenant(deps.db, tenant.tenantId, async (tx) =>
    load(tx, await requireAdmin(tx, tenant.userId, roles), tenant),
  );
  return c.json(body as object);
}

export interface WriteOptions {
  readonly roles?: readonly AdminRole[];
  /** 资源级校验（活动可见、对象归属）：命令前与命令事务内各执行一次，重放同样经过。 */
  readonly guard?: (tx: Tx, admin: Admin) => Promise<void>;
  /**
   * 命令前（含幂等重放）、事务外的额外校验：复用组织员工侧的路由鉴权（module-route-access.ts 的 objectContext /
   * requestScope 自己开事务），放在 360 身份与资源校验之后执行；命令事务内由业务代码按同一对象重验。
   */
  readonly preflight?: (admin: Admin) => Promise<void>;
  readonly status?: 200 | 201;
  /** 替换默认的“须为 360 管理员”判定（管理员任命另认企业管理员的管理员管理能力）。 */
  readonly actor?: (tx: Tx, tenant: TenantContext) => Promise<Admin>;
  /** 不针对单个带 revision 对象的命令（如同步）：不要求 If-Match。 */
  readonly revisionFree?: boolean;
}

/**
 * 写命令：先在独立事务里校验当前身份与资源（含幂等重放，结果不会绕过当前权限返回），再进入命令执行器
 * （业务写 + 审计 + 命令台账同一事务，AGENTS.md §10）。请求体在资源校验之后才解析，范围外的资源不会因请求体
 * 不合法而暴露为 400。
 */
export async function write<T>(
  c: C,
  deps: TenantRouteDeps,
  schema: z.ZodType<T>,
  execute: (tx: Tx, ctx: Survey360Context, input: T) => Promise<unknown>,
  options: WriteOptions = {},
): Promise<Response> {
  const tenant = tenantOf(c);
  const resolveActor = (tx: Tx) =>
    options.actor ? options.actor(tx, tenant) : requireAdmin(tx, tenant.userId, options.roles);
  const admin = await withTenant(deps.db, tenant.tenantId, async (tx) => {
    const current = await resolveActor(tx);
    await options.guard?.(tx, current);
    return current;
  });
  await options.preflight?.(admin);
  const expectedRevision = options.revisionFree ? 0 : revision(c);
  const input = parse(schema, await jsonOrEmpty(c));
  const result = await runCommand(deps.db, tenant, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: expectedRevision, input },
    execute: async (tx, commandId): Promise<CommandResult> => {
      const admin = await resolveActor(tx);
      await options.guard?.(tx, admin);
      const ctx: Survey360Context = { ...tenant, now: deps.clock(), commandId, admin, expectedRevision };
      return { status: options.status ?? 200, body: await execute(tx, ctx, input) };
    },
  });
  return c.json(result.body as object, result.status);
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '请求字段不合法', parsed.error.issues);
  return parsed.data;
}

export async function jsonOrEmpty(c: C): Promise<unknown> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('VALIDATION_FAILED', '请求体不是合法 JSON');
  }
}

export function requireRevision(current: number, expected: number): void {
  if (current !== expected)
    throw new AppError('REVISION_CONFLICT', '数据已被修改，请刷新后显式重提', { expected, current });
}

export function requireNewObject(ctx: { expectedRevision: number }): void {
  if (ctx.expectedRevision !== 0) throw new AppError('REVISION_CONFLICT', '新建对象的 revision 必须为 0');
}

export interface AuditEntry {
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly before: unknown;
  /** 活动内对象的 after 一律带 activityId，审计查看按活动授权裁剪（audit/visibility.ts）。 */
  readonly after: unknown;
}

export async function audit360(
  tx: Tx,
  ctx: Pick<Survey360Context, 'tenantId' | 'commandId' | 'now'> & { readonly actorUserId: string | null },
  entry: AuditEntry,
): Promise<void> {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorUserId,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    ...entry,
  });
}

/** 写入方：管理员命令或链接作答（外部评价者没有账号，操作人记为空、显示为“系统”）。 */
export interface Writer {
  readonly tenantId: string;
  readonly userId: string;
  readonly commandId: string;
  readonly now: Date;
}

export function actor(ctx: Writer) {
  return { tenantId: ctx.tenantId, commandId: ctx.commandId, now: ctx.now, actorUserId: auditActor(ctx.userId) };
}

/** 唯一键冲突、序列化失败转为统一错误码。 */
export function mapDbError(error: unknown): AppError | undefined {
  const code = pgErrorCode(error);
  if (code === '23505')
    return new AppError('CONFLICT', '数据已存在（邮箱、名称或评价关系重复）', { reason: 'DUPLICATE' });
  if (['40P01', '40001', '55P03'].includes(code ?? ''))
    return new AppError('REVISION_CONFLICT', '数据正在变更，请刷新后显式重提');
  return undefined;
}

// DEC-194：与 F-017 同一口径，UUID 一律按小写规范化
export const uuid = z.uuid().transform((value) => value.toLowerCase());
export const text = (max = 200) => z.string().trim().min(1).max(max);
export const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));
export const email = z
  .email()
  .max(320)
  .transform((v) => v.trim());
