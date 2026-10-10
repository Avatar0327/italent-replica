/**
 * 人才评定配置写入的公共部分（设计 §3.2、§5.1、§8）：每个写入在命令台账的同一租户事务里完成“业务写 + 审计”
 * （DEC-019 / 216）。取锁顺序：被引用方 FOR SHARE → 本对象行 FOR UPDATE（B1a 只有本对象，无被引用方）。
 */
import { pgErrorCode, sql, type Tx } from '@italent/db';
import { EVALUATION_AUDIT_ACTIONS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { scopeAllows } from '../permission/module-access.js';
import type { FormRefAccess, FormVisibility } from './form-refs.js';
import type { PersonRefAccess } from './person-refs.js';
import {
  codeOf,
  EVALUATION_LABELS,
  type EvaluationContext,
  type EvaluationObject,
  type ModuleScope,
  requireVisible,
  rowsOf,
  scopePredicate,
} from './access.js';

/** 写命令的上下文：请求上下文 + 查看人当前的范围（按对象，事务外解析）。 */
export interface WriteContext extends EvaluationContext {
  readonly scope: ModuleScope;
  /** 引用人员的对象（评审组成员）：员工信息的查看权 / 范围 / 字段（路由层按当前权限解析）。 */
  readonly persons?: PersonRefAccess;
  /** 评价表的引用（通用评分项 / 指标）：对象查看权 / 范围 / 字段（命令事务内解析）。 */
  readonly forms?: FormRefAccess;
  /** 通用评分项写命令：引用方（评价表）的可见范围，停用被引用时只列看得到的（命令事务内解析）。 */
  readonly formVisibility?: FormVisibility;
}

export const TABLES: Readonly<Partial<Record<EvaluationObject, string>>> = {
  activityType: 'ev_activity_types',
  activityCycle: 'ev_cycles',
  generalScoreItem: 'ev_general_items',
  reviewGroup: 'ev_review_groups',
  evaluationForm: 'ev_forms',
};

export function tableOf(object: EvaluationObject): string {
  const table = TABLES[object];
  if (!table) throw new Error(`没有登记${EVALUATION_LABELS[object]}的表`);
  return table;
}

interface AccessRow {
  readonly revision: number;
  readonly visible: boolean;
  readonly [column: string]: unknown;
}

/** 读一行并按 `scope` 判定可见（读写同一谓词）；`lock` 为行锁模式。 */
export async function rowAccess(
  tx: Tx,
  ctx: EvaluationContext,
  scope: ModuleScope,
  object: EvaluationObject,
  id: string,
  lock?: 'UPDATE' | 'SHARE',
): Promise<{ visible: boolean; row: AccessRow | undefined }> {
  const result = await tx.execute(sql`SELECT t.*, (${scopePredicate(scope, object)}) AS visible
    FROM ${sql.identifier(tableOf(object))} t WHERE t.tenant_id = ${ctx.tenantId}::uuid AND t.id = ${id}::uuid
    ${lock ? sql.raw(`FOR ${lock} OF t`) : sql``}`);
  const row = rowsOf<AccessRow>(result)[0];
  return { visible: row?.visible === true, row };
}

/** 写入的定位：行锁 → 可见（不可见与不存在同一个 404）→ revision。 */
export async function lockEditable(tx: Tx, ctx: WriteContext, object: EvaluationObject, id: string) {
  const { visible, row } = await rowAccess(tx, ctx, ctx.scope, object, id, 'UPDATE');
  requireVisible(visible, object);
  if (row!.revision !== ctx.expectedRevision) {
    throw new AppError('REVISION_CONFLICT', `${EVALUATION_LABELS[object]}已变更，请刷新后显式重提`, {
      expected: ctx.expectedRevision,
      actual: row!.revision,
    });
  }
  return row!;
}

export async function audit(
  tx: Tx,
  ctx: EvaluationContext,
  object: EvaluationObject,
  operation: string,
  id: string,
  change: { before: unknown; after: unknown; orgId?: string | null },
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `${EVALUATION_AUDIT_ACTIONS[object]}.${operation}`,
    objectType: codeOf(object),
    objectId: id,
    before: change.before,
    after: change.after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    // DEC-197 归属：所属组织对象的审计按查看人当前范围裁剪（设计 §8，orgRule）
    ...(change.orgId ? { scope: { orgId: change.orgId } } : {}),
  });
}

/**
 * 唯一约束冲突（并发兜底与常规重名都走这里）转成 409：专用 reason + 调用方给出的提示。事务随后整体回滚，业务与审计都不留。
 */
export async function guardUnique<T>(work: () => Promise<T>, conflict: () => AppError): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw conflict();
    throw error;
  }
}

/** 原生 SQL 参数：时间一律传 ISO 字符串（postgres-js 不接受 Date 参数，PGlite 接受，见 idp 同法）。 */
export const bumped = (ctx: EvaluationContext) => ({
  revision: ctx.expectedRevision + 1,
  updatedAt: ctx.now.toISOString(),
});

/** 所属组织：须存在且在操作人范围内；不存在与范围外同一个 404。 */
export async function requireOwnerOrg(tx: Tx, ctx: WriteContext, orgId: string): Promise<void> {
  const found = rowsOf(
    await tx.execute(sql`SELECT 1 FROM org_objects WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${orgId}::uuid`),
  );
  if (!found.length || !scopeAllows(ctx.scope, { orgId })) throw new AppError('NOT_FOUND', '所属组织不存在');
}

export { rowsOf };
