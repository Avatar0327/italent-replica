/**
 * 盘点配置对象的通用读写骨架（设计 §2.2、§7 配置 CRUD 行；DEC-216）：分类 / 角色 / 字段共用。准备度字典（PR-A）早于本骨架，
 * 保持原样。每个写入在命令台账的同一租户事务里完成“业务写 + 审计”；写入前对行 FOR UPDATE 再校验范围与 revision；
 * 范围外与不存在同一个 404（AGENTS §10）；删除前在同一事务内询问引用方登记的守卫（被引用 409 <对象>_IN_USE），删除保留快照。
 */
import { and, asc, eq, pgErrorCode, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import {
  codeOf,
  type ModuleScope,
  notFoundMessage,
  requireConfigCreatable,
  requireConfigVisible,
  TALENT_REVIEW_AUDIT_ACTIONS,
  type TalentReviewContext,
} from './access.js';

export type ConfigObject =
  'category' | 'role' | 'field' | 'matrix' | 'calcRule' | 'scoreRule' | 'moduleGrade' | 'form' | 'flow';

export interface WriteContext extends TalentReviewContext {
  readonly scope: ModuleScope;
}

export type ConfigTable = PgTable & {
  readonly id: AnyPgColumn;
  readonly tenantId: AnyPgColumn;
  readonly name: AnyPgColumn;
  readonly enabled: AnyPgColumn;
  readonly revision: AnyPgColumn;
  readonly createdBy: AnyPgColumn;
  readonly updatedBy: AnyPgColumn;
  readonly updatedAt: AnyPgColumn;
};

export interface ConfigSpec<V extends { id: string; name: string }> {
  readonly object: ConfigObject;
  readonly label: string;
  readonly table: ConfigTable;
  /** 视图列（含 id / name / revision / createdBy）。 */
  readonly view: Record<string, AnyPgColumn>;
  /** 默认排序键（字段编码 + 列）；列表只用查看人可见的那些（visibleOrder），最后总以 id 收尾。 */
  readonly orderBy: readonly OrderKey[];
  /** 编码或名称撞唯一约束时的原因码。 */
  readonly duplicate: string;
  readonly inUse: string;
  /** 视图装配（字段目录要带选项）；缺省 = 列映射。 */
  readonly load?: (tx: Tx, tenantId: string, id: string) => Promise<V | undefined>;
}

/** 返回引用方编码（如 'TEMPLATE_MODULE'）表示被引用；返回 null 表示未引用。 */
export type ConfigReferenceGuard = (tx: Tx, tenantId: string, id: string) => Promise<string | null>;
const guards: Record<ConfigObject, ConfigReferenceGuard[]> = {
  category: [],
  role: [],
  field: [],
  scoreRule: [],
  moduleGrade: [],
  matrix: [],
  calcRule: [],
  form: [],
  flow: [],
};

/** 引用方（项目、模板、公式…）在加载时登记；删除时同事务逐个询问。 */
export function registerConfigReferenceGuard(object: ConfigObject, guard: ConfigReferenceGuard): void {
  if (!guards[object].includes(guard)) guards[object].push(guard);
}

export async function configReferrer(tx: Tx, tenantId: string, object: ConfigObject, id: string) {
  for (const guard of guards[object]) {
    const referrer = await guard(tx, tenantId, id);
    if (referrer) return referrer;
  }
  return null;
}

export async function loadConfig<V extends { id: string; name: string }>(
  tx: Tx,
  spec: ConfigSpec<V>,
  tenantId: string,
  id: string,
): Promise<V | undefined> {
  if (spec.load) return spec.load(tx, tenantId, id);
  const [row] = await tx
    .select(spec.view)
    .from(spec.table)
    .where(and(eq(spec.table.tenantId, tenantId), eq(spec.table.id, id)));
  return row as V | undefined;
}

/** 排序键：字段编码 + 列。 */
export type OrderKey = readonly [field: string, column: AnyPgColumn];

/**
 * 列表排序只用查看人看得到的排序字段（PR #182 审查：管理员只改隐藏的 sortNo / code / name 就会改变查看人第一页看到的
 * 对象，泄露隐藏值的大小关系）；看不到的键直接跳过，最后由调用方以 id 收尾。viewable 为 undefined 表示全部可见。
 */
export const visibleOrder = (keys: readonly OrderKey[], viewable: ReadonlySet<string> | undefined): AnyPgColumn[] =>
  keys.filter(([field]) => viewable === undefined || viewable.has(field)).map(([, column]) => column);

export function listConfig(
  tx: Tx,
  spec: Pick<ConfigSpec<never>, 'table' | 'view' | 'orderBy'>,
  tenantId: string,
  query: {
    limit: number;
    offset: number;
    enabled?: boolean;
    visible: SQL;
    /** 查看人可见的字段（getModuleViewableFields）；必填，避免漏传时退回按隐藏字段排序。 */
    viewable: ReadonlySet<string> | undefined;
  },
) {
  const filters = [eq(spec.table.tenantId, tenantId), query.visible];
  if (query.enabled !== undefined) filters.push(eq(spec.table.enabled, query.enabled));
  return tx
    .select(spec.view)
    .from(spec.table)
    .where(and(...filters))
    .orderBy(...visibleOrder(spec.orderBy, query.viewable).map((column) => asc(column)), asc(spec.table.id))
    .limit(query.limit)
    .offset(query.offset);
}

/** 行锁 → 范围（范围外与不存在同一个 404）→ revision。 */
export async function lockConfigRow(
  tx: Tx,
  spec: Pick<ConfigSpec<never>, 'table' | 'object' | 'label'>,
  ctx: WriteContext,
  id: string,
) {
  const [row] = await tx
    .select({ revision: spec.table.revision, createdBy: spec.table.createdBy })
    .from(spec.table)
    .where(and(eq(spec.table.tenantId, ctx.tenantId), eq(spec.table.id, id)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', notFoundMessage(spec.object));
  requireConfigVisible(ctx.scope, spec.object, row.createdBy as string | null);
  if (row.revision !== ctx.expectedRevision) {
    throw new AppError('REVISION_CONFLICT', `${spec.label}已变更，请刷新后显式重提`, {
      expected: ctx.expectedRevision,
      actual: row.revision,
    });
  }
}

/**
 * 并发写入被数据库中止（死锁 40P01、序列化失败 40001、锁超时 55P03）时的受控结果：409 CONFLICT（CONCURRENT_WRITE），
 * 客户端刷新后显式重提，不自动盲重试（AGENTS §10「并发」；F-082 契约 §3.4：唯一键冲突的等待不纳入锁序，死锁检测中止一方）。
 */
export async function concurrentOr<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (['40P01', '40001', '55P03'].includes(pgErrorCode(error) ?? '')) {
      throw new AppError('CONFLICT', '并发写入冲突，请刷新后显式重提', { reason: 'CONCURRENT_WRITE' });
    }
    throw error;
  }
}

export async function uniqueOr<T>(duplicate: string, label: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw new AppError('CONFLICT', `${label}编码或名称重复`, { reason: duplicate });
    throw error;
  }
}

export async function auditConfig(
  tx: Tx,
  ctx: WriteContext,
  object: ConfigObject | 'settings',
  operation: 'create' | 'update' | 'delete',
  id: string,
  before: unknown,
  after: unknown,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `${TALENT_REVIEW_AUDIT_ACTIONS[object]}.${operation}`,
    objectType: codeOf(object),
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

/**
 * 名称租户唯一，改成他人隐藏记录的名称会撞唯一约束，409 与成功的差异会暴露隐藏记录的存在（准备度第 2 轮 P2-01）。
 * 所以改名要求看全部，判定在任何查重之前，目标名称是否被占用都同一个 403。
 */
export function requireSeeAllToRename(ctx: WriteContext, before: { name: string }, name: string | undefined) {
  if (name !== undefined && name !== before.name && !ctx.scope.all) {
    throw new AppError('FORBIDDEN', '只有能查看全部的人可以修改名称', { reason: 'NAME_REQUIRES_SEE_ALL' });
  }
}

export async function createConfig<V extends { id: string; name: string }>(
  tx: Tx,
  spec: ConfigSpec<V>,
  ctx: WriteContext,
  values: Record<string, unknown>,
  /** 聚合的子数据（如字段选项）在创建审计之前写入，创建快照才是完整聚合（DEC-216）。 */
  writeChildren?: (id: string) => Promise<void>,
): Promise<V> {
  requireConfigCreatable(ctx.scope, spec.object);
  const [row] = await uniqueOr(spec.duplicate, spec.label, () =>
    tx
      .insert(spec.table)
      .values({
        tenantId: ctx.tenantId,
        ...values,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning({ id: spec.table.id }),
  );
  await writeChildren?.(row!.id as string);
  const after = (await loadConfig(tx, spec, ctx.tenantId, row!.id as string))!;
  await auditConfig(tx, ctx, spec.object, 'create', after.id, null, after);
  return after;
}

export async function updateConfig<V extends { id: string; name: string }>(
  tx: Tx,
  spec: ConfigSpec<V>,
  ctx: WriteContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<V> {
  await lockConfigRow(tx, spec, ctx, id);
  const before = (await loadConfig(tx, spec, ctx.tenantId, id))!;
  requireSeeAllToRename(ctx, before, patch.name as string | undefined);
  await uniqueOr(spec.duplicate, spec.label, () =>
    tx
      .update(spec.table)
      .set({ ...patch, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(spec.table.tenantId, ctx.tenantId), eq(spec.table.id, id))),
  );
  const after = (await loadConfig(tx, spec, ctx.tenantId, id))!;
  await auditConfig(tx, ctx, spec.object, 'update', id, before, after);
  return after;
}

export async function deleteConfig<V extends { id: string; name: string }>(
  tx: Tx,
  spec: ConfigSpec<V>,
  ctx: WriteContext,
  id: string,
  beforeDelete?: (before: V) => void | Promise<void>,
): Promise<V> {
  await lockConfigRow(tx, spec, ctx, id);
  const before = (await loadConfig(tx, spec, ctx.tenantId, id))!;
  await beforeDelete?.(before);
  const referrer = await configReferrer(tx, ctx.tenantId, spec.object, id);
  if (referrer) {
    throw new AppError('CONFLICT', `${spec.label}已被引用，不能删除，可以停用`, { reason: spec.inUse, referrer });
  }
  await tx.delete(spec.table).where(and(eq(spec.table.tenantId, ctx.tenantId), eq(spec.table.id, id)));
  await auditConfig(tx, ctx, spec.object, 'delete', id, before, null);
  return before;
}
