/**
 * 人才标准写入的公共部分（docs/02_业务建模/23 §2.2；DEC-281⑨）：每个写入在命令台账的同一租户事务里完成
 * “业务写 + 审计”（DEC-019 / 216），审计行带所属管理单元作归属（审计查询按管理单元裁剪）。
 * 取锁顺序：人才标准 → 指标 → 分类 / 类型 → 指标库（引用方对被引用行加 FOR SHARE，停用 / 删除被引用行先 FOR UPDATE），
 * 因此“停用后不可新引用”（TC-R4）与“被引用不可删”（TC-R5）在并发下同样成立；外键 RESTRICT 兜底。
 */
import { sql, type Tx } from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import {
  codeOf,
  isDictionary,
  type ModuleScope,
  type Owner,
  requireCreatable,
  requireVisible,
  TALENT_AUDIT_ACTIONS,
  TALENT_LABELS,
  type TalentContext,
  type TalentObject,
} from './access.js';
import { usageCount } from './read-model.js';

/** 写入时引用其他对象须各自可见（DEC-178 同口径）；null 表示查看人没有该对象的查看权。 */
export type ReferenceScopes = Partial<Record<TalentObject, ModuleScope | null>>;

/** 引用对象上查看人当前可见的字段（undefined = 全部；没有查看权为空集），带出值前按它裁剪（DEC-309）。 */
export type ReferenceFields = Partial<Record<TalentObject, ReadonlySet<string> | undefined>>;

export interface WriteContext extends TalentContext {
  readonly scope: ModuleScope;
  readonly references: ReferenceScopes;
  readonly referenceFields: ReferenceFields;
}

export const TALENT_TABLES: Readonly<Record<TalentObject, string>> = {
  library: 'talent_dimension_libraries',
  dimensionCategory: 'talent_dimension_categories',
  descriptionType: 'talent_description_types',
  dimension: 'talent_dimensions',
  criterionCategory: 'talent_criterion_categories',
  criterion: 'talent_criteria',
};

interface OwnerRow {
  readonly revision: number;
  readonly owner_org_id: string | null;
  readonly owner_id: string | null;
}

/** 读一行的 revision 与范围锚点并加锁；字典对象没有所属管理单元，“所属人”即创建人。 */
async function lockRow(tx: Tx, object: TalentObject, tenantId: string, id: string, mode: 'UPDATE' | 'SHARE') {
  const owner = isDictionary(object)
    ? sql`NULL::uuid AS owner_org_id, created_by AS owner_id`
    : sql`owner_org_id, owner_id`;
  const result = await tx.execute(sql`SELECT revision, ${owner} FROM ${sql.identifier(TALENT_TABLES[object])}
    WHERE tenant_id = ${tenantId} AND id = ${id}::uuid FOR ${sql.raw(mode)}`);
  return rowsOf<OwnerRow>(result)[0];
}

const ownerOf = (row: OwnerRow): Owner => ({ orgId: row.owner_org_id, ownerId: row.owner_id });

/** 行锁 → 范围（范围外与不存在同样 404）→ revision。 */
export async function lockOwned(tx: Tx, ctx: WriteContext, object: TalentObject, id: string): Promise<void> {
  const row = await lockRow(tx, object, ctx.tenantId, id, 'UPDATE');
  if (!row) throw new AppError('NOT_FOUND', `${TALENT_LABELS[object]}不存在`);
  requireVisible(ctx.scope, object, ownerOf(row));
  if (row.revision !== ctx.expectedRevision) {
    throw new AppError('REVISION_CONFLICT', `${TALENT_LABELS[object]}已变更，请刷新后显式重提`, {
      expected: ctx.expectedRevision,
      actual: row.revision,
    });
  }
}

/**
 * 被引用的对象：共享锁（与它的停用 / 删除串行）→ 存在 → 查看人对该对象有查看权且在其范围内。
 * 返回它的范围锚点（所属管理单元 / 所属人），供挂在它下面新建时判定新建范围（库内分类、指标）。
 */
export async function referenced(tx: Tx, ctx: WriteContext, object: TalentObject, id: string): Promise<Owner> {
  const scope = ctx.references[object];
  if (scope === null) throw new AppError('FORBIDDEN', `无权查看${TALENT_LABELS[object]}`);
  const row = await lockRow(tx, object, ctx.tenantId, id, 'SHARE');
  if (!row) throw new AppError('NOT_FOUND', `${TALENT_LABELS[object]}不存在`);
  if (!scope) throw new Error(`未解析${TALENT_LABELS[object]}的引用范围`);
  requireVisible(scope, object, ownerOf(row));
  return ownerOf(row);
}

/**
 * 挂在指标库下新建（库内分类、指标）：库须可见（referenced），且库的所属管理单元在操作人对新对象的管理范围内
 * （DEC-082，不因“使用用户”规则放行）。范围外与库不存在同一个 404（第 5 轮清单 2）。
 */
export function requireLibraryCreatable(ctx: WriteContext, object: TalentObject, library: Owner): void {
  requireCreatable(ctx.scope, object, library.orgId, `${TALENT_LABELS.library}不存在`);
}

/** 删除前的“还在使用”判断：有引用即 409，数据不变。 */
export async function rejectInUse(
  tx: Tx,
  ctx: WriteContext,
  usage: { table: string; column: string; id: string; reason: string; message: string },
) {
  if ((await usageCount(tx, usage.table, usage.column, ctx.tenantId, usage.id)) > 0) {
    throw new AppError('CONFLICT', usage.message, { reason: usage.reason });
  }
}

export async function audit(
  tx: Tx,
  ctx: TalentContext,
  object: TalentObject,
  operation: 'create' | 'update' | 'delete',
  id: string,
  change: { before: unknown; after: unknown; orgId?: string | null },
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `${TALENT_AUDIT_ACTIONS[object]}.${operation}`,
    objectType: codeOf(object),
    objectId: id,
    before: change.before,
    after: change.after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    // DEC-197 归属：审计查询按查看人当前的管理单元裁剪，删除后仍可判断
    ...(change.orgId ? { scope: { orgId: change.orgId } } : {}),
  });
}

export const created = (ctx: TalentContext) => ({ createdBy: ctx.userId, createdAt: ctx.now, updatedAt: ctx.now });
export const owned = (ctx: TalentContext, ownerOrgId: string) => ({ ownerId: ctx.userId, ownerOrgId });
export const bumped = (ctx: TalentContext) => ({ revision: ctx.expectedRevision + 1, updatedAt: ctx.now });

export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
