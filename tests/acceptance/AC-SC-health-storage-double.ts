/** #282 未合并时的 SQL 存储契约替身；不复制 B5 迁移、约束或业务实现。真实表存在则直接用真实表。 */
import { sql, type Db } from '@italent/db';
import { rowsOf } from './support/f048.js';

export async function healthStorageDouble(db: Db) {
  const [table] = rowsOf<{ name: string | null }>(
    await db.execute(sql`SELECT to_regclass('succession_health_results')::text name`),
  );
  if (table?.name) return false;
  await db.execute(sql`CREATE TABLE succession_health_results (
    tenant_id uuid NOT NULL,org_id uuid NOT NULL,level_id uuid,method text NOT NULL,revision integer NOT NULL,
    run_id uuid,computed_at timestamptz,assigned_by uuid,source_batch_id uuid,source_project_id uuid,
    source_meeting_id uuid,PRIMARY KEY(tenant_id,org_id))`);
  await db.execute(sql`GRANT SELECT,INSERT,UPDATE ON succession_health_results TO app_user`);
  await db.execute(sql`SELECT enable_tenant_isolation('succession_health_results')`);
  await db.execute(sql`ALTER TABLE succession_target_locks DROP CONSTRAINT succession_target_locks_kind`);
  await db.execute(sql`ALTER TABLE succession_target_locks ADD CONSTRAINT succession_target_locks_kind
    CHECK(target_kind IN ('org','position','org_health'))`);
  return true;
}
