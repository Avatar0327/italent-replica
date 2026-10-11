/**
 * 配置聚合对盘点字段 / 盘点角色的引用复核（表单引用字段、流程节点引用角色；与九宫格引用字段同一套规则）：
 * - 写入路径对被引用行加 FOR KEY SHARE：与被引用对象的删除（行 FOR UPDATE）互斥，先删就读不到（404），
 *   读到了就保证提交前不被删，删除方随后看到占用 → 409 *_IN_USE，不会在插入时撞外键 500；
 * - 请求里显式提交的引用（含原样带上的已有引用）都须当前操作人在目录范围内可见，看不到与不存在同一个 404；
 * - 新引用的对象不能是已停用的（400）；聚合已持有的引用原样保留可改。
 */
import { and, eq, inArray, type Tx } from '@italent/db';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { AppError } from '../../errors.js';
import { notFoundMessage, requireConfigVisible, type ModuleScope } from './access.js';
import type { WriteContext } from './config-kit.js';

export type ReferencedObject = 'field' | 'role';
export type ReferencedTable = PgTable & {
  readonly id: AnyPgColumn;
  readonly tenantId: AnyPgColumn;
  readonly enabled: AnyPgColumn;
  readonly createdBy: AnyPgColumn;
};

export interface ReferenceWriteContext extends WriteContext {
  /** 被引用目录对象（字段 / 角色）的范围；请求不带任何引用时为空。 */
  readonly referenceScope?: ModuleScope;
  /** 请求里显式提交的引用 id；首次执行在业务事务内、任何写入之前复核，拒绝时整个命令回滚。 */
  readonly references?: readonly string[];
}

interface Facts {
  readonly enabled: boolean;
  readonly createdBy: string | null;
}

async function loadFacts(tx: Tx, table: ReferencedTable, tenantId: string, ids: readonly string[], lock: boolean) {
  if (ids.length === 0) return new Map<string, Facts>();
  const query = tx
    .select({ id: table.id, enabled: table.enabled, createdBy: table.createdBy })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), inArray(table.id, [...ids])));
  const rows = (await (lock ? query.for('key share') : query)) as (Facts & { id: string })[];
  return new Map(rows.map((row) => [row.id, row]));
}

function requireVisible(
  object: ReferencedObject,
  scope: ModuleScope | undefined,
  facts: Map<string, Facts>,
  ids: readonly string[],
) {
  for (const id of ids) {
    const found = facts.get(id);
    if (!found) throw new AppError('NOT_FOUND', notFoundMessage(object));
    if (!scope) throw new Error('引用缺少目录范围');
    requireConfigVisible(scope, object, found.createdBy);
  }
}

/** 命令重放的授权复核（与业务校验分开）：撤销目录范围后原命令重放同样 404（AGENTS §10）。 */
export async function requireReferencesVisible(
  tx: Tx,
  table: ReferencedTable,
  object: ReferencedObject,
  tenantId: string,
  ids: readonly string[],
  scope: ModuleScope,
): Promise<void> {
  const unique = [...new Set(ids)];
  requireVisible(object, scope, await loadFacts(tx, table, tenantId, unique, false), unique);
}

/** 写入前复核：全部显式引用可见；其中新增的（不在 held 里）不能已停用。 */
export async function checkReferences(
  tx: Tx,
  ctx: ReferenceWriteContext,
  spec: { table: ReferencedTable; object: ReferencedObject; disabledReason: string; label: string },
  ids: readonly string[],
  held: ReadonlySet<string>,
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const facts = await loadFacts(tx, spec.table, ctx.tenantId, unique, true);
  requireVisible(spec.object, ctx.referenceScope, facts, unique);
  for (const id of unique) {
    if (!held.has(id) && !facts.get(id)!.enabled) {
      throw new AppError('VALIDATION_FAILED', `${spec.label}已停用，不能新增引用`, { reason: spec.disabledReason });
    }
  }
}
