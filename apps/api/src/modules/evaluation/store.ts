/**
 * 人才评定配置写入的公共部分（设计 §3.2、§5.1、§8）：每个写入在命令台账的同一租户事务里完成“业务写 + 审计”
 * （DEC-019 / 216）。取锁顺序：被引用方 FOR SHARE → 本对象行 FOR UPDATE（B1a 只有本对象，无被引用方）。
 */
import { sql, type Tx } from '@italent/db';
import { EVALUATION_AUDIT_ACTIONS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
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
}

export const TABLES: Readonly<Partial<Record<EvaluationObject, string>>> = {
  activityType: 'ev_activity_types',
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
  change: { before: unknown; after: unknown },
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
  });
}

/** 原生 SQL 参数：时间一律传 ISO 字符串（postgres-js 不接受 Date 参数，PGlite 接受，见 idp 同法）。 */
export const bumped = (ctx: EvaluationContext) => ({
  revision: ctx.expectedRevision + 1,
  updatedAt: ctx.now.toISOString(),
});

export { rowsOf };
