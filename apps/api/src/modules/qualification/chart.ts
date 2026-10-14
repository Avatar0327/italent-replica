/** 图谱查看与导出共用的 PR-A 取数路径；调用方先校验读取谓词，再加载标准与级别顺序。 */
import { sql, type Tx } from '@italent/db';
import { rowsOf, type QualificationContext } from './access.js';
import * as read from './read-model.js';

export async function loadChart(tx: Tx, ctx: QualificationContext, id: string) {
  const [standard] = await read.withStandardParts(tx, ctx.tenantId, [
    (await read.loadRow(tx, ctx.tenantId, 'standard', id))!,
  ]);
  const levels = rowsOf<{ id: string; display_order: number }>(
    await tx.execute(sql`SELECT id, display_order FROM ql_levels WHERE tenant_id = ${ctx.tenantId}::uuid
      AND id = ANY(${`{${standard!.levelIds.join(',')}}`}::uuid[])`),
  );
  return { standard: standard!, orders: new Map(levels.map((level) => [level.id, level.display_order])) };
}
