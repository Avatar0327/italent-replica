/** 类别 / 级别删除的唯一入口：FOR UPDATE 后查全部引用；新增引用经 assertQualificationRefs 的 FOR SHARE 串行。 */
import { sql, type Tx } from '@italent/db';
import { lockEditable, rejectInUse, type WriteContext } from './store.js';

export async function lockUnusedQualificationRef(
  tx: Tx,
  ctx: WriteContext,
  object: 'category' | 'level',
  id: string,
): ReturnType<typeof lockEditable> {
  const row = await lockEditable(tx, ctx, object, id);
  const column = object === 'category' ? 'category_id' : 'level_id';
  const array = object === 'category' ? 'category_ids' : 'level_ids';
  const standard = object === 'category' ? sql`${id}::uuid = category_id` : sql`${id}::uuid = ANY(level_ids)`;
  await rejectInUse(tx, {
    sql: sql`SELECT 1 FROM ql_standards WHERE tenant_id = ${ctx.tenantId}::uuid AND ${standard}
      UNION ALL SELECT 1 FROM ql_development_channels WHERE tenant_id = ${ctx.tenantId}::uuid
        AND ${sql.identifier(`target_${column}`)} = ${id}::uuid
      UNION ALL SELECT 1 FROM personnel_qualification WHERE tenant_id = ${ctx.tenantId}::uuid
        AND ${sql.identifier(column)} = ${id}::uuid
      UNION ALL SELECT 1 FROM ev_activities WHERE tenant_id = ${ctx.tenantId}::uuid
        AND ${id}::uuid = ANY(${sql.identifier(array)})
      UNION ALL SELECT 1 FROM ev_conditions WHERE tenant_id = ${ctx.tenantId}::uuid
        AND ${id}::uuid = ANY(${sql.identifier(array)})`,
    message: `该任职${object === 'category' ? '类别' : '级别'}已被标准、发展通道、评定活动或员工任职资格记录引用，不能删除`,
    reason: object === 'category' ? 'CATEGORY_IN_USE' : 'LEVEL_IN_USE',
  });
  return row;
}
