/**
 * 360 模块公共装配（R3-T03）：读接口、写命令（幂等台账 + 审计同事务）与错误口径。
 * 360 身份照 DEC-280 走平台“身份 × 应用”（应用 Survey360）：功能权限、字段权限与数据范围都由 permission 模块判定。
 * 第 3 轮（总编排补充）：每个路由声明对象、操作、按钮与写字段来源，统一接 module-route-access.ts 的公共守卫——
 * 路由层（命令前，含幂等重放）objectContext / button / requestScope / writeFields，命令事务内用 authorizeInTransaction
 * 按同一对象 / 按钮重验；返回前（新请求与重放同一路径）按请求人当时的权限复核并裁剪响应（AGENTS.md §10「权限」）。
 * 第 4 轮（DEC-297③）：载荷引用的资源（人员、导入行的评价对象与评价者、上级、挂接目标）同样在命令前按当前范围
 * 复核（refs），命中台账的幂等重放也经过，与新命令同一判定、同一错误码。
 */
import { pgErrorCode, sql, type Tx, withTenant } from '@italent/db';
import { buttonResource, survey360, tenantLocalDate } from '@italent/domain';
import type { Context } from 'hono';
import { z } from 'zod';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError, type ErrorCode } from '../../errors.js';
import { recordAudit } from '../../audit/record.js';
import { auditActor } from '../../system-actor.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantContext, type TenantEnv } from '../../tenant-context.js';
import { revision } from '../job/context.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  type ModuleScope,
} from '../permission/module-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { button, objectContext, requestScope, writeFields } from '../permission/module-route-access.js';
import { EMPTY_SCOPE } from '../permission/scope-types.js';
import { superiorSnapshots } from './superior.js';

export const OBJECTS = survey360.SURVEY360_OBJECTS;
export const BUTTONS = survey360.SURVEY360_BUTTONS;
export type ObjectKey = keyof typeof OBJECTS;
export type Operation = 'view' | 'create' | 'update' | 'delete';

/**
 * 一个路由要的功能权限：360 对象上的数据操作（缺省查看）与按钮。按钮缺省为对象目录里与数据操作同名的按钮
 * （新增 / 编辑 / 删除，第 3 轮 R2-P2-6），显式按钮（启用、导入、同步……）替代缺省；查看不要按钮。
 */
export interface Need {
  readonly object: ObjectKey;
  readonly operation?: Operation;
  readonly button?: string;
}

/** 360 操作人：当前用户、是否持“全部活动”按钮，以及精细化权限下的人员范围。 */
export interface Admin {
  readonly userId: string;
  readonly allActivities: boolean;
  /** 精细化权限生效（开关开、没有“全部活动”按钮）时的 360 人员范围（DEC-280⑤、DEC-289①）；null = 不受限。 */
  readonly people: ModuleScope | null;
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

/** 路由要判的按钮：显式按钮，或对象目录里与数据操作同名的按钮；查看不要按钮。 */
export function buttonOf(need: Need): string | undefined {
  if (need.button) return need.button;
  const operation = need.operation ?? 'view';
  if (operation === 'view') return undefined;
  const buttons = OBJECTS[need.object].buttons as readonly { code: string }[];
  return buttons.some((b) => b.code === operation) ? operation : undefined;
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

async function requireNeed(tx: Tx, deps: TenantRouteDeps, tenant: TenantContext, need: Need): Promise<void> {
  if (!(await can(tx, deps, tenant, need.object, need.operation, buttonOf(need))))
    fail('FORBIDDEN', '没有执行该 360 操作的权限');
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

/** “精细化权限”开关（DEC-280⑤）；未设置即关闭。 */
export async function finePermission(tx: Tx): Promise<boolean> {
  const [row] = rows<{ fine_permission: boolean }>(
    await tx.execute(sql`SELECT fine_permission FROM survey360_settings LIMIT 1`),
  );
  return row?.fine_permission === true;
}

/** 是否持“全部活动”按钮（360 系统管理员：看全部活动、不受精细化权限限制）。 */
export async function allActivitiesOf(tx: Tx, deps: Pick<TenantRouteDeps, 'authorize'>, tenant: TenantContext) {
  return can(tx, deps, tenant, 'activity', 'view', BUTTONS.allActivities);
}

/**
 * 只带身份的操作人（DEC-369）：处理函数只用 userId 的入口不必为“全部活动 / 精细化范围”预取授权——这两项只给活动 /
 * 人员可见范围用（activityVisibleSql、requireActivity、personVisible …），读它们说明入口选错了模式。
 * 两个字段设成不可枚举的访问器，误用时当场抛错，展开运算符也不会碰到。
 */
function identityOnly(userId: string): Admin {
  const unavailable = (field: string) => () => {
    throw new Error(`该入口按 admin: 'identity' 注册，未加载 ${field}（需要活动 / 人员可见范围的入口用 'full'）`);
  };
  return Object.defineProperties({ userId } as Admin, {
    allActivities: { get: unavailable('allActivities') },
    people: { get: unavailable('people') },
  });
}

/** 'full' = 查“全部活动”按钮与精细化范围（缺省）；'identity' = 只带 userId（DEC-369，处理函数不用可见范围的入口）。 */
export type AdminMode = 'full' | 'identity';

/**
 * 当前 360 操作人。people = 路由层取得的人员范围；精细化生效却没有取到范围时按空范围处理（fail-closed）。
 */
export async function loadAdmin(
  tx: Tx,
  deps: Pick<TenantRouteDeps, 'authorize'>,
  tenant: TenantContext,
  people?: ModuleScope,
  mode: AdminMode = 'full',
): Promise<Admin> {
  if (mode === 'identity') return identityOnly(tenant.userId);
  const allActivities = await allActivitiesOf(tx, deps, tenant);
  if (allActivities || !(await finePermission(tx))) return { userId: tenant.userId, allActivities, people: null };
  const scope = people ?? EMPTY_SCOPE;
  return { userId: tenant.userId, allActivities, people: scope.all ? null : scope };
}

/** 路由层（命令前，含幂等重放）：直接复用 module-route-access 的 objectContext / button。 */
async function routeNeed(c: C, deps: TenantRouteDeps, need: Need): Promise<ScopeBusinessContext> {
  const code = OBJECTS[need.object].code;
  const ctx = await objectContext(c, deps, code, need.operation ?? 'view');
  const buttonCode = buttonOf(need);
  if (buttonCode) await button(deps, ctx, code, buttonCode, levelOf(need.object, buttonCode));
  return ctx;
}

/** 会读写 360 人员的对象：人员、评价关系（评价对象 / 评价者）、结果、答卷（PR-B 原始数据、屏蔽与重新作答）。 */
const PERSON_OBJECTS: ReadonlySet<ObjectKey> = new Set(['person', 'relation', 'result', 'answer']);

/**
 * 路由层取（用户 × Survey360）数据范围（requestScope），按 360 人员改写：管理单元 / 组织条件按挂接员工的当前任职
 * 组织判定（与员工信息同一套 SQL，scope-persons.ts）；创建人按人员 created_by；汇报关系维度解析器不给 360 人员
 * 汇报线查询，按 fail-closed 不放行（Q-M0-112，已知限制）。只在会读写 360 人员的路由上取。
 */
async function routePeople(c: C, deps: TenantRouteDeps, ctx: ScopeBusinessContext, object: ObjectKey) {
  if (!PERSON_OBJECTS.has(object)) return undefined;
  const scope = await requestScope(c, deps, ctx, OBJECTS.person.code);
  if (scope.all) return scope;
  const personQuery = {
    kind: 'organization' as const,
    tenantId: ctx.tenantId,
    asOf: tenantLocalDate(deps.clock(), ctx.timezone),
  };
  const terms = (scope.terms ?? [{ dimension: 'management', orgIds: scope.orgIds, personIds: scope.personIds }]).map(
    (term) => (term.dimension === 'management' || term.dimension === 'organization' ? { ...term, personQuery } : term),
  );
  return { ...scope, terms } satisfies ModuleScope;
}

/** 返回前的查看人：读接口、写响应与重放都在这里按当前权限裁剪。 */
export interface Viewer {
  readonly tx: Tx;
  readonly tenant: TenantContext;
  readonly admin: Admin;
  /** 查看人在该 360 对象上可见的字段（undefined = 不限），同一次裁剪内缓存。 */
  fields(object: ObjectKey): Promise<ReadonlySet<string> | undefined>;
}

/** 响应复核与裁剪：每个路由登记一个（缺省按路由对象的查看字段）。 */
export type Present = (viewer: Viewer, body: never) => Promise<unknown>;

function viewerOf(tx: Tx, deps: TenantRouteDeps, tenant: TenantContext, admin: Admin): Viewer {
  const cache = new Map<ObjectKey, Promise<ReadonlySet<string> | undefined>>();
  return {
    tx,
    tenant,
    admin,
    fields(object) {
      let found = cache.get(object);
      if (!found) {
        found = getModuleViewableFieldsInTransaction(deps, tenant, OBJECTS[object].code, tx);
        cache.set(object, found);
      }
      return found;
    },
  };
}

/** 协议键：删除 / 移除回执里的状态键，不是对象字段，随对象字段一起返回。 */
const PROTOCOL = new Set(['deleted', 'removed']);

/** 只留可见字段（键缺席）；alias 把行里的键映射到对象字段（如候选人员的 personId → id）。 */
export function pick(
  row: object,
  fields: ReadonlySet<string> | undefined,
  alias: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const entries = Object.entries(row);
  if (fields === undefined) return Object.fromEntries(entries);
  return Object.fromEntries(entries.filter(([key]) => PROTOCOL.has(key) || fields.has(alias[key] ?? key)));
}

/** 单个对象，或列表信封（items 逐行裁剪，page / pageSize 等信封键不动）。 */
export function trimBody(fields: ReadonlySet<string> | undefined, body: unknown): unknown {
  if (fields === undefined || body === null || typeof body !== 'object') return body;
  const items = (body as { items?: unknown }).items;
  if (Array.isArray(items)) return { ...body, items: items.map((row: object) => pick(row, fields)) };
  return pick(body, fields);
}

/**
 * 嵌套层（报告快照、报表列头）的键 → 决定它可见的对象字段（第 2 轮 P2-4）：同一个值的各种表示（分数的 self / other /
 * gap / value / reference、报表的 values）都归到同一个字段，查看人看不到该字段时任何层级都去掉。
 */
export function trimAliases(
  fields: ReadonlySet<string> | undefined,
  body: unknown,
  aliases: Readonly<Record<string, string>>,
): unknown {
  if (fields === undefined) return body;
  const hidden = new Set(Object.keys(aliases).filter((key) => !fields.has(aliases[key]!)));
  if (!hidden.size) return body;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !hidden.has(k))
        .map(([k, v]) => [k, walk(v)]),
    );
  };
  return walk(body);
}

/** 按某个 360 对象的查看字段裁剪。 */
export const trimAs =
  (object: ObjectKey): Present =>
  async (viewer, body: unknown) =>
    trimBody(await viewer.fields(object), body);

/** 不按 360 对象字段裁剪的回执（授权两栏的账号信息，不是 360 对象），用处逐路由写明原因。 */
export const asIs: Present = async (_viewer, body: unknown) => body;

/**
 * 读接口：路由层判功能权限（objectContext；查看不要按钮，显式按钮照判），会读写 360 人员的路由取数据范围；事务内
 * 取操作人后读取，再按 present 裁剪（缺省按路由对象的查看字段）。load 内抛出的 404 / 403 原样返回。
 */
export async function read<T>(
  c: C,
  deps: TenantRouteDeps,
  need: Need,
  load: (tx: Tx, admin: Admin, tenant: TenantContext) => Promise<T>,
  present: Present = trimAs(need.object),
  adminMode: AdminMode = 'full',
): Promise<Response> {
  const route = await routeNeed(c, deps, need);
  const people = await routePeople(c, deps, route, need.object);
  const tenant = tenantOf(c);
  const body = await withTenant(deps.db, tenant.tenantId, async (tx) => {
    const admin = await loadAdmin(tx, deps, tenant, people, adminMode);
    return present(viewerOf(tx, deps, tenant, admin), (await load(tx, admin, tenant)) as never);
  });
  return c.json(body as object);
}

/** 隐式写入的其他 360 对象（如录入 person 即新建 360 人员）：同样判对象.操作、按钮与字段编辑权。 */
export interface Also {
  readonly need: Need;
  readonly fields: readonly string[];
}

export interface WriteOptions<T> {
  readonly need: Need;
  /**
   * 写字段来源（第 3 轮 R2-P2-5）：'body' = 请求体的键；函数 = 按实际载荷列出的对象字段；'none' = 不写对象字段
   * （状态流转、授权名单、同步类协议参数），新增 / 编辑时交给 writeFields 按字段编辑权限校验。
   */
  readonly fields: 'body' | 'none' | ((input: T) => readonly string[]);
  readonly also?: (input: T) => readonly Also[];
  /** 资源级校验（活动可见、对象 / 人员可见、套卷本人）：命令前与命令事务内各执行一次，重放同样经过。 */
  readonly guard?: (tx: Tx, admin: Admin) => Promise<void>;
  /**
   * 载荷引用的资源（第 4 轮 R3-P2-1）：解析请求体、校验字段编辑权之后，进入命令执行器之前按请求人当前的范围复核
   * ——命中台账的幂等重放同样经过，与新命令同一判定、同一错误码（不返回历史结果）；命令事务内由业务代码按同一判定
   * 重验。已移除的资源按移除前判定可见（与删除类重放同一口径）。
   */
  readonly refs?: (tx: Tx, admin: Admin, input: T) => Promise<void>;
  /**
   * 结果引用的资源（第 5 轮 R4-P2-1）：返回前（新请求与重放同一路径）按结果里的稳定 ID（人员、评价者、评价关系）
   * 按请求人当前的范围复核，不按载荷重新解析——录入的邮箱可能已转给别人，refs 判的是邮箱现在的持有人，台账返回的
   * 却是当时解析出的资源。看不到时与新命令引用看不到的资源同一错误，不返回历史结果。
   */
  readonly results?: (tx: Tx, admin: Admin, body: never) => Promise<void>;
  /**
   * 命令前（含幂等重放）、事务外的额外校验：复用组织员工侧的路由鉴权（objectContext / requestScope 自己开事务），
   * 放在功能权限与资源校验之后执行；命令事务内由业务代码按同一对象重验。
   */
  readonly preflight?: (admin: Admin) => Promise<void>;
  /** 返回前复核与裁剪（新请求与重放同一路径，按请求人当时的权限）；缺省按路由对象的查看字段。 */
  readonly present?: Present;
  readonly status?: 200 | 201;
  /** 不针对单个带 revision 对象的命令（如同步）：不要求 If-Match。 */
  readonly revisionFree?: boolean;
  /** 缺省 'full'；处理函数 / 守卫 / 复核都不用活动与人员可见范围的入口登记 'identity'（DEC-369）。 */
  readonly admin?: AdminMode;
}

const asPayload = (fields: readonly string[]) => Object.fromEntries(fields.map((field) => [field, true]));

/** 路由层的字段编辑校验：路由对象按声明的写字段，隐式写入的对象另判功能权限、按钮与字段。 */
async function routeFields<T>(
  c: C,
  deps: TenantRouteDeps,
  route: ScopeBusinessContext,
  options: WriteOptions<T>,
  input: T,
  also: readonly Also[],
) {
  const operation = options.need.operation;
  if ((operation === 'create' || operation === 'update') && options.fields !== 'none') {
    const fields = options.fields === 'body' ? Object.keys(input as object) : options.fields(input);
    await writeFields(deps, route, OBJECTS[options.need.object].code, operation, asPayload(fields));
  }
  for (const extra of also) {
    const ctx = await routeNeed(c, deps, extra.need);
    const op = extra.need.operation;
    if (op === 'create' || op === 'update')
      await writeFields(deps, ctx, OBJECTS[extra.need.object].code, op, asPayload(extra.fields));
  }
}

/**
 * 写命令：路由层判功能权限与按钮，在独立事务里校验路径资源（含幂等重放，结果不会绕过当前权限返回），解析请求体后
 * 按声明的写字段校验字段编辑权限、按当前范围复核载荷引用的资源，再进入命令执行器（业务写 + 审计 + 命令台账同一
 * 事务，AGENTS.md §10），事务内重验功能权限与资源。返回前（新请求与重放同一路径）按请求人当时的权限复核结果引用的
 * 资源（第 5 轮 R4-P2-1），再复核并裁剪响应（第 3 轮 R2-P2-2）。请求体在路径资源校验之后才解析，范围外的路径资源
 * 不会因请求体不合法而暴露为 400。
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
  const people = await routePeople(c, deps, route, options.need.object);
  const checked = async (tx: Tx) => {
    await requireNeed(tx, deps, tenant, options.need);
    const admin = await loadAdmin(tx, deps, tenant, people, options.admin);
    await options.guard?.(tx, admin);
    return admin;
  };
  const admin = await withTenant(deps.db, tenant.tenantId, checked);
  await options.preflight?.(admin);
  const expectedRevision = options.revisionFree ? 0 : revision(c);
  const input = parse(schema, await jsonOrEmpty(c));
  const also = options.also?.(input) ?? [];
  await routeFields(c, deps, route, options, input, also);
  const refs = options.refs;
  if (refs) await withTenant(deps.db, tenant.tenantId, (tx) => refs(tx, admin, input));
  const result = await runCommand(deps.db, tenant, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: expectedRevision, input },
    execute: async (tx, commandId): Promise<CommandResult> => {
      const current = await checked(tx);
      for (const extra of also) await requireNeed(tx, deps, tenant, extra.need);
      const ctx: Survey360Context = { ...tenant, now: deps.clock(), commandId, admin: current, expectedRevision };
      return { status: options.status ?? 200, body: await execute(tx, ctx, input) };
    },
  });
  const present = options.present ?? trimAs(options.need.object);
  const body = await withTenant(deps.db, tenant.tenantId, async (tx) => {
    const viewer = viewerOf(tx, deps, tenant, await loadAdmin(tx, deps, tenant, people, options.admin));
    await options.results?.(tx, viewer.admin, result.body as never);
    return present(viewer, result.body as never);
  });
  return c.json(body as object, result.status);
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
  const snapshots =
    entry.objectType === 'survey360-person'
      ? await superiorSnapshots(tx, ctx.tenantId, entry.before, entry.after)
      : { before: entry.before, after: entry.after };
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorUserId,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    ...entry,
    ...snapshots,
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
