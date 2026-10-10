/**
 * 简单字典（无组织字段、无唯一约束）的写入服务工厂：活动周期、通用评分项（设计 §3.2、§5.1）。看全部 ∪ 创建人，新建只认看全部
 * （DEC-121 / DEC-082 / DEC-356②）。每个写入口在命令台账的同一事务里写业务与审计。活动类型有自己的规则（名称唯一、
 * 拒停用），见 activity-type-service.ts。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { EVALUATION_LABELS, type EvaluationObject } from './access.js';
import { reload } from './read-model.js';
import type { View } from './route-support.js';
import { audit, bumped, lockEditable, rowsOf, type WriteContext } from './store.js';
import { rejectInUse } from './usage.js';

interface DictionaryField {
  /** 请求 / 视图里的字段编码。 */
  readonly field: string;
  readonly column: string;
  /** 新建时未给的缺省值。 */
  readonly fallback: unknown;
}

export interface DictionarySpec {
  readonly object: EvaluationObject;
  readonly table: string;
  readonly fields: readonly DictionaryField[];
}

type Body = Readonly<Record<string, unknown>>;

export function dictionaryService(spec: DictionarySpec) {
  const { object, table } = spec;
  const tableId = sql.identifier(table);
  return {
    async create(tx: Tx, ctx: WriteContext, body: Body): Promise<View> {
      // 新建只认看全部：创建人维度的人不能新建（与不存在同一个 404）
      if (!ctx.scope.all) throw new AppError('NOT_FOUND', `${EVALUATION_LABELS[object]}不存在`);
      const now = ctx.now.toISOString();
      const columns = spec.fields.map(({ column }) => sql.identifier(column));
      const values = spec.fields.map(({ field, fallback }) => (body[field] ?? fallback) as never);
      const result = await tx.execute(sql`INSERT INTO ${tableId}
          (tenant_id, ${sql.join(columns, sql`, `)}, created_by, created_at, updated_at)
        VALUES (${ctx.tenantId}, ${sql.join(values, sql`, `)}, ${ctx.userId}, ${now}, ${now}) RETURNING id`);
      const id = rowsOf<{ id: string }>(result)[0]!.id;
      const after = await reload<View>(tx, ctx.tenantId, object, id);
      await audit(tx, ctx, object, 'create', id, { before: null, after });
      return after;
    },
    async update(tx: Tx, ctx: WriteContext, id: string, body: Body): Promise<View> {
      await lockEditable(tx, ctx, object, id);
      const before = await reload<View>(tx, ctx.tenantId, object, id);
      const bump = bumped(ctx);
      const sets = spec.fields
        .filter(({ field }) => body[field] !== undefined)
        .map(({ field, column }) => sql`${sql.identifier(column)} = ${body[field] as never}`);
      sets.push(sql`revision = ${bump.revision}`, sql`updated_at = ${bump.updatedAt}`);
      await tx.execute(sql`UPDATE ${tableId} SET ${sql.join(sets, sql`, `)}
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
      const after = await reload<View>(tx, ctx.tenantId, object, id);
      await audit(tx, ctx, object, 'update', id, { before, after });
      return after;
    },
    async remove(tx: Tx, ctx: WriteContext, id: string): Promise<View> {
      await lockEditable(tx, ctx, object, id);
      // 引用方由 B4 / B5 在 usage.ts 登记（delete 阶段）
      await rejectInUse(tx, ctx, object, id);
      const before = await reload<View>(tx, ctx.tenantId, object, id);
      await tx.execute(sql`DELETE FROM ${tableId} WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
      await audit(tx, ctx, object, 'delete', id, { before, after: null });
      return before;
    },
  };
}

export const activityCycles = dictionaryService({
  object: 'activityCycle',
  table: 'ev_cycles',
  fields: [
    { field: 'name', column: 'name', fallback: undefined },
    { field: 'enabled', column: 'enabled', fallback: true },
  ],
});

export const generalScoreItems = dictionaryService({
  object: 'generalScoreItem',
  table: 'ev_general_items',
  fields: [
    { field: 'name', column: 'name', fallback: undefined },
    { field: 'description', column: 'description', fallback: null },
    { field: 'enabled', column: 'enabled', fallback: true },
  ],
});
