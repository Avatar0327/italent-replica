/** S3 结构验收用合成对象身份；不依赖任职 / 当前资格，DEC-909 只校验租户内类别。 */
import { sql, withPlatform, withTenant, type Db } from '@italent/db';
export async function seedCellObjects(
  db: Db,
  tenantId: string,
  structure: {
    columns: { key: string; kind: string; dimension?: string | null }[];
    rows: { cells: Record<string, string[]> }[];
  },
) {
  const groups = new Map<string, Set<string>>();
  for (const c of structure.columns) {
    const kind = c.kind === 'role' ? 'person' : c.dimension!;
    const ids = groups.get(kind) ?? new Set<string>();
    for (const row of structure.rows) for (const id of row.cells[c.key] ?? []) ids.add(id.toLowerCase());
    groups.set(kind, ids);
  }
  for (const [kind, ids] of groups) {
    for (const id of ids) {
      if (kind === 'person') {
        await withPlatform(db, (tx) =>
          tx.execute(sql`INSERT INTO users (id,display_name,email)
          VALUES (${id}::uuid,'合成单元格人员',${`cell-${id}@example.com`}) ON CONFLICT DO NOTHING`),
        );
        await withTenant(db, tenantId, (tx) =>
          tx.execute(sql`INSERT INTO tenant_memberships (tenant_id,user_id)
          VALUES (${tenantId}::uuid,${id}::uuid) ON CONFLICT DO NOTHING`),
        );
      } else {
        const table =
          kind === 'department' ? 'org_objects' : kind === 'position' ? 'job_position_objects' : 'job_post_objects';
        await withTenant(db, tenantId, (tx) =>
          tx.execute(sql`INSERT INTO ${sql.identifier(table)} (tenant_id,id)
          VALUES (${tenantId}::uuid,${id}::uuid) ON CONFLICT DO NOTHING`),
        );
      }
    }
  }
}
