/** 仅升级夹具：当前 API 在旧表造数时临时使用来源结构，正式迁移前恢复旧列与约束。 */
import { type DbHandle, sql } from '@italent/db';

const rows = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
export async function withPreApprovalSources(handle: DbHandle): Promise<DbHandle> {
  const columns = rows<{ column_name: string; data_type: string }>(
    await handle.db.execute(sql`
    SELECT column_name,data_type FROM information_schema.columns
    WHERE table_name='approval_process_nodes' AND column_name IN ('approver_expression','approver_expressions')`),
  );
  if (!columns.some((c) => c.column_name === 'approver_expression' && c.data_type === 'text')) return handle;
  const checks = rows<{ conname: string; definition: string }>(
    await handle.db.execute(sql`
    SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='approval_process_nodes'::regclass
      AND conname IN ('approval_nodes_approver','approval_nodes_approvers')`),
  );
  const hasMany = columns.some((c) => c.column_name === 'approver_expressions');
  await handle.db.transaction(async (tx) => {
    for (const c of checks)
      await tx.execute(sql.raw(`ALTER TABLE approval_process_nodes DROP CONSTRAINT "${c.conname}"`));
    const mapping = `WHEN v='owner' THEN 'custom_variable' WHEN v='handover_hr_admin' THEN 'identity'
    WHEN v LIKE '%department_%' OR v LIKE '%org_head' THEN 'department' ELSE 'object_field'`;
    await tx.execute(
      sql.raw(`CREATE FUNCTION pg_temp.test_source(v text) RETURNS jsonb LANGUAGE sql AS $$
    SELECT CASE WHEN v IS NULL THEN NULL ELSE jsonb_build_object('type', CASE ${mapping} END, 'value', v) END $$`),
    );
    await tx.execute(
      sql.raw(`CREATE FUNCTION pg_temp.test_sources(v text[]) RETURNS jsonb LANGUAGE sql AS $$
    SELECT COALESCE(jsonb_agg(pg_temp.test_source(x) ORDER BY n),'[]'::jsonb)
    FROM unnest(v) WITH ORDINALITY a(x,n) $$`),
    );
    await tx.execute(sql`ALTER TABLE approval_process_nodes ALTER COLUMN approver_expression TYPE jsonb
    USING pg_temp.test_source(approver_expression)`);
    if (hasMany) {
      await tx.execute(sql`ALTER TABLE approval_process_nodes ALTER COLUMN approver_expressions DROP DEFAULT`);
      await tx.execute(sql`ALTER TABLE approval_process_nodes ALTER COLUMN approver_expressions TYPE jsonb
      USING pg_temp.test_sources(approver_expressions)`);
      await tx.execute(
        sql`ALTER TABLE approval_process_nodes ALTER COLUMN approver_expressions SET DEFAULT '[]'::jsonb`,
      );
    }
    await tx.execute(
      sql`ALTER TABLE approval_process_nodes ADD COLUMN empty_approver_sources jsonb DEFAULT '[]'::jsonb`,
    );
  });
  let pending = true;
  return {
    ...handle,
    async migrate(folder) {
      if (pending) {
        pending = false;
        await handle.db.transaction(async (tx) => {
          await tx.execute(sql`ALTER TABLE approval_process_nodes DROP COLUMN empty_approver_sources`);
          await tx.execute(sql`ALTER TABLE approval_process_nodes ALTER COLUMN approver_expression TYPE text
        USING approver_expression->>'value'`);
          if (hasMany) {
            await tx.execute(sql`CREATE FUNCTION pg_temp.test_values(v jsonb) RETURNS text[] LANGUAGE sql AS $$
          SELECT COALESCE(array_agg(x->>'value' ORDER BY n),'{}'::text[])
          FROM jsonb_array_elements(v) WITH ORDINALITY a(x,n) $$`);
            await tx.execute(sql`ALTER TABLE approval_process_nodes ALTER COLUMN approver_expressions DROP DEFAULT`);
            await tx.execute(sql`ALTER TABLE approval_process_nodes ALTER COLUMN approver_expressions TYPE text[]
          USING pg_temp.test_values(approver_expressions)`);
            await tx.execute(
              sql`ALTER TABLE approval_process_nodes ALTER COLUMN approver_expressions SET DEFAULT '{}'::text[]`,
            );
          }
          for (const c of checks)
            await tx.execute(
              sql.raw(`ALTER TABLE approval_process_nodes ADD CONSTRAINT "${c.conname}" ${c.definition}`),
            );
        });
      }
      return handle.migrate(folder);
    },
  };
}
