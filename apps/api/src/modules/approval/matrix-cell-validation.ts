/** DEC-909②：验证格值对象类别；按稳定对象核对本租户及类别，不把停用误判成类别变化。 */
import { sql, type Tx } from '@italent/db';
import { rowsOf } from './context.js';
import { matrixInvalid } from './matrix-input.js';
import type { MatrixStructure } from './matrix-structure.js';

export async function assertMatrixCellKinds(tx: Tx, tenantId: string, structure: MatrixStructure) {
  const ids = [...new Set(structure.rows.flatMap((row) => Object.values(row.cells).flat()))];
  if (!ids.length) return;
  // 按租户读对象身份，不看生效日 / 启停；同 UUID 如在多个类别合法存在，只要本列类别存在即接受。
  const filter = `{${ids.join(',')}}`;
  const rows = rowsOf<{ id: string; kind: string }>(
    await tx.execute(sql`
    SELECT user_id::text AS id, 'person' AS kind FROM tenant_memberships
      WHERE tenant_id=${tenantId}::uuid AND user_id =ANY(${filter}::uuid[])
    UNION ALL SELECT id::text, 'department' FROM org_objects
      WHERE tenant_id=${tenantId}::uuid AND id =ANY(${filter}::uuid[])
    UNION ALL SELECT id::text, 'position' FROM job_position_objects
      WHERE tenant_id=${tenantId}::uuid AND id =ANY(${filter}::uuid[])
    UNION ALL SELECT id::text, 'job' FROM job_post_objects
      WHERE tenant_id=${tenantId}::uuid AND id =ANY(${filter}::uuid[])`),
  );
  const kinds = new Map<string, Set<string>>();
  for (const row of rows) {
    const group = kinds.get(row.id) ?? new Set<string>();
    group.add(row.kind);
    kinds.set(row.id, group);
  }
  for (const column of structure.columns) {
    const kind = column.kind === 'role' ? 'person' : column.dimension!;
    for (const row of structure.rows) {
      for (const id of row.cells[column.id] ?? []) {
        const known = kinds.get(id);
        if (!known?.has(kind)) matrixInvalid('MATRIX_CELL_KIND_MISMATCH', '单元格值的类别与列类型不一致');
      }
    }
  }
}
