/**
 * 360 模块公共装配（R3-T03）：写命令（幂等台账 + 审计同事务）与错误口径。
 * 360 身份照 DEC-280 走平台“身份 × 应用”（应用 Survey360）：功能权限、字段权限与数据范围都由 permission 模块判定，
 * 路由层直接复用 module-route-access.ts 的 objectContext / button / writeFields，命令事务内用 authorizeInTransaction
 * 按同一对象 / 按钮重验（AGENTS.md §10「权限」），幂等重放同样先经过当前校验。
 */
import { pgErrorCode, sql, type Tx, withTenant } from '@italent/db';
import { buttonResource, survey360 } from '@italent/domain';
import type { Context } from 'hono';
import { z } from 'zod';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError, type ErrorCode } from '../../errors.js';
import { recordAudit } from '../../audit/record.js';
import { auditActor } from '../../system-actor.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantContext, type TenantEnv } from '../../tenant-context.js';
import { revision } from '../job/context.js';
import { authorizeInTransaction, getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { button, objectContext, writeFields } from '../permission/module-route-access.js';

export const OBJECTS = survey360.SURVEY360_OBJECTS;
export const BUTTONS = survey360.SURVEY360_BUTTONS;
export type ObjectKey = keyof typeof OBJECTS;
export type Operation = 'view' | 'create' | 'update' | 'delete';

/** 一次请求要的功能权限：360 对象上的数据操作（缺省查看），可另要一个按钮；'holder' = 持有任一 360 身份即可。 */
export type Need = { readonly object: ObjectKey; readonly operation?: Operation; readonly button?: string } | 'holder';

/** 360 操作人：当前用户，以及是否持“全部活动”按钮（系统管理员：看全部活动、不受精细化权限限制）。 */
export interface Admin {
  readonly userId: string;
  readonly allActivities: boolean;
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

function levelOf(object: ObjectKey, code: string): 'list' | 'detail' {
  const found = (OBJECTS[object].buttons as readonly { code: string; level: string }[]).find((b) => b.code === code);
  if (!found) throw new Error(`360 对象 ${object} 没有按钮 ${code}`);
  return found.level as 'list' | 'detail';
}

/** 事务内判定当前用户在 360 对象上的数据操作与按钮（与路由层同一判定，permission 的 decide）。 */
export async function can(
  tx: Tx,
  deps: Pick<TenantRouteDeps, 'authorize'>,
  tenant: TenantContext,
  object: ObjectKey,
  operation: Operation = 'view',
  buttonCode?: string,
): Promise<boolean> {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  const code = OBJECTS[object].code;
  if (!(await authorize({ ...tenant, action: `object.${operation}`, resource: code, fields: [] }))) return false;
  if (!buttonCode) return true;
  const resource = buttonResource(code, buttonCode, levelOf(object, buttonCode));
  return authorize({ ...tenant, action: 'object.button', resource });
}

/** 持有人：当前有效用户授权里有登记了 Survey360 应用的身份（DEC-280②）。 */
export async function isHolder(tx: Tx, userId: string): Promise<boolean> {
  const [row] = rows<{ ok: boolean }>(
    await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM permission_grants g
      JOIN permission_profile_apps a ON a.tenant_id = g.tenant_id AND a.profile_id = g.profile_id
      WHERE g.user_id = ${userId}::uuid AND g.status = 'active' AND a.app_code = ${survey360.SURVEY360_APP}) AS ok`),
  );
  return row?.ok === true;
}

async function requireNeed(tx: Tx, deps: TenantRouteDeps, tenant: TenantContext, need: Need): Promise<void> {
  const allowed =
    need === 'holder'
      ? await isHolder(tx, tenant.userId)
      : await can(tx, deps, tenant, need.object, need.operation, need.button);
  if (!allowed) fail('FORBIDDEN', '没有执行该 360 操作的权限');
}

export async function loadAdmin(tx: Tx, deps: Pick<TenantRouteDeps, 'authorize'>, tenant: TenantContext) {
  const allActivities = await can(tx, deps, tenant, 'activity', 'view', BUTTONS.allActivities);
  return { userId: tenant.userId, allActivities } satisfies Admin;
}

/** 路由层（命令前，含幂等重放）：直接复用 module-route-access 的 objectContext / button。 */
async function routeNeed(c: C, deps: TenantRouteDeps, need: Need) {
  if (need === 'holder') return undefined;
  const code = OBJECTS[need.object].code;
  const ctx = await objectContext(c, deps, code, need.operation ?? 'view');
  if (need.button) await button(deps, ctx, code, need.button, levelOf(need.object, need.button));
  return ctx;
}

/** 按查看人在该 360 对象上的查看字段裁剪（键缺席）；列表裁 items 的每一行，信封字段（计数、提示）不动。 */
async function trimTo(tx: Tx, deps: TenantRouteDeps, tenant: TenantContext, object: ObjectKey, body: unknown) {
  const fields = await getModuleViewableFieldsInTransaction(deps, tenant, OBJECTS[object].code, tx);
  if (fields === undefined || body === null || typeof body !== 'object') return body;
  const trim = (row: object) => Object.fromEntries(Object.entries(row).filter(([key]) => fields.has(key)));
  const items = (body as { items?: unknown }).items;
  if (Array.isArray(items)) return { ...body, items: items.map((row: object) => trim(row)) };
  return trim(body);
}

/**
 * 读接口：路由层判功能权限，事务内取操作人后读取，再按 trim 指定的 360 对象裁剪字段。
 * load 内抛出的 404 / 403 原样返回。
 */
export async function read<T>(
  c: C,
  deps: TenantRouteDeps,
  need: Need,
  load: (tx: Tx, admin: Admin, tenant: TenantContext) => Promise<T>,
  trim?: ObjectKey,
): Promise<Response> {
  await routeNeed(c, deps, need);
  const tenant = tenantOf(c);
  const body = await withTenant(deps.db, tenant.tenantId, async (tx) => {
    if (need === 'holder') await requireNeed(tx, deps, tenant, need);
    const loaded = await load(tx, await loadAdmin(tx, deps, tenant), tenant);
    return trim ? trimTo(tx, deps, tenant, trim, loaded) : loaded;
  });
  return c.json(body as object);
}

export interface WriteOptions<T> {
  readonly need: Need;
  /** 资源级校验（活动可见、对象归属、套卷本人）：命令前与命令事务内各执行一次，重放同样经过。 */
  readonly guard?: (tx: Tx, admin: Admin) => Promise<void>;
  /**
   * 命令前（含幂等重放）、事务外的额外校验：复用组织员工侧的路由鉴权（objectContext / requestScope 自己开事务），
   * 放在功能权限与资源校验之后执行；命令事务内由业务代码按同一对象重验。
   */
  readonly preflight?: (admin: Admin) => Promise<void>;
  /** 新增 / 编辑时要写的字段（交给 writeFields 按字段编辑权限校验）。 */
  readonly fields?: (input: T) => Readonly<Record<string, unknown>>;
  readonly status?: 200 | 201;
  /** 不针对单个带 revision 对象的命令（如同步）：不要求 If-Match。 */
  readonly revisionFree?: boolean;
}

/**
 * 写命令：路由层判功能权限，再在独立事务里校验资源（含幂等重放，结果不会绕过当前权限返回），解析请求体后按字段
 * 编辑权限校验，最后进入命令执行器（业务写 + 审计 + 命令台账同一事务，AGENTS.md §10），事务内重验功能权限与资源。
 * 请求体在资源校验之后才解析，范围外的资源不会因请求体不合法而暴露为 400。
 */
export async function write<T>(
  c: C,
  deps: TenantRouteDeps,
  schema: z.ZodType<T>,
  execute: (tx: Tx, ctx: Survey360Context, input: T) => Promise<unknown>,
  options: WriteOptions<T>,
): Promise<Response> {
  const tenant = tenantOf(c);
  const route = await routeNeed(c, deps, options.need);
  const checked = async (tx: Tx) => {
    await requireNeed(tx, deps, tenant, options.need);
    const admin = await loadAdmin(tx, deps, tenant);
    await options.guard?.(tx, admin);
    return admin;
  };
  const admin = await withTenant(deps.db, tenant.tenantId, checked);
  await options.preflight?.(admin);
  const expectedRevision = options.revisionFree ? 0 : revision(c);
  const input = parse(schema, await jsonOrEmpty(c));
  const operation = options.need === 'holder' ? undefined : options.need.operation;
  if (route && options.fields && options.need !== 'holder' && (operation === 'create' || operation === 'update'))
    await writeFields(deps, route, OBJECTS[options.need.object].code, operation, options.fields(input));
  const result = await runCommand(deps.db, tenant, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: expectedRevision, input },
    execute: async (tx, commandId): Promise<CommandResult> => {
      const current = await checked(tx);
      const ctx: Survey360Context = { ...tenant, now: deps.clock(), commandId, admin: current, expectedRevision };
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
