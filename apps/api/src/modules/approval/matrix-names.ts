import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { rowsOf, type ApprovalContext } from './context.js';
import { eligibleDesignerPeople } from './designer-people.js';
import { jobReferenceRows, orgReferenceRows } from './source-reference.js';
import type { MatrixStructure } from './matrix-structure.js';

/** 名称仅附在本租户已返回的引用上，人员沿设计器姓名 / 工号 / 部门投影，绝不透出账号凭据。 */
export async function matrixReferenceNames(tx: Tx, ctx: ApprovalContext, structure: MatrixStructure) {
  const groups = new Map<string, Set<string>>();
  for (const column of structure.columns) {
    const kind = column.kind === 'role' ? 'person' : column.dimension!;
    const ids = groups.get(kind) ?? new Set<string>();
    for (const row of structure.rows) for (const id of row.cells[column.id] ?? []) ids.add(id);
    groups.set(kind, ids);
  }
  const names: Record<string, unknown> = {};
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  for (const [kind, ids] of groups) {
    if (!ids.size) {
      names[kind] = {};
      continue;
    }
    if (kind === 'person') {
      const people = await eligibleDesignerPeople(tx, ctx.tenantId, {
        userIds: [...ids],
        limit: ids.size,
        offset: 0,
        asOf,
      });
      const byId = new Map(people.map((p) => [p.userId, p]));
      names[kind] = Object.fromEntries([...ids].map((id) => [id, byId.get(id) ?? null]));
    } else {
      const query =
        kind === 'department'
          ? orgReferenceRows(ctx.tenantId, asOf, 'admin')
          : jobReferenceRows(ctx.tenantId, asOf, kind as 'position' | 'job');
      const rows = rowsOf<{ id: string; name: string }>(
        await tx.execute(sql`
        SELECT c.id,c.name FROM (${query}) c WHERE c.id=ANY(${`{${[...ids].join(',')}}`}::uuid[])`),
      );
      const byId = new Map(rows.map((r) => [r.id, r.name]));
      names[kind] = Object.fromEntries([...ids].map((id) => [id, byId.get(id) ?? null]));
    }
  }
  return names;
}
