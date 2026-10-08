/**
 * 升级测试夹具（R1-T16）：在迁移 0057 / 0058 之前的结构上用当前接口造前置数据时，审计写入会带上 R1-T16 新增的列，
 * 并在解析引用名称时调用 0058 的 current_tenant_timezone()。这里临时补出这些列与函数，前置步骤跑完即撤掉，
 * 再由测试执行升级迁移；前置步骤写入的审计行只保留升级前就有的列，等同历史数据。已升级的库直接执行。
 * R3-T07（DEC-318）起审批流程节点多了 4 个开关列，当前接口装审批流程时会写它们：旧结构上同样临时补出（取迁移的
 * 缺省值），前置步骤后撤掉，由升级迁移按缺省值补回。
 */
import { type Db, sql } from '@italent/db';

const COLUMNS = [
  ['operation', 'text'],
  ['changes', 'jsonb'],
  ['source_action', 'text'],
  ['source_page_type', 'text'],
  ['source_page', 'text'],
  ['terminal', 'text'],
  ['client_version', 'text'],
  ['ip', 'text'],
  ['trace_id', 'text'],
  ['scope_object', 'text'],
  ['scope_employee_id', 'uuid'],
  ['scope_org_id', 'uuid'],
] as const;

/** 审批流程节点开关列（迁移 0069，缺省值与迁移一致）。 */
const NODE_COLUMNS = [
  ['avoid_self', 'boolean NOT NULL DEFAULT true'],
  ['allow_revoke', 'boolean NOT NULL DEFAULT true'],
  ['allow_reject_previous', 'boolean NOT NULL DEFAULT false'],
  ['allow_jump', 'boolean NOT NULL DEFAULT false'],
] as const;

/** 旧结构上缺的节点开关列：临时补出，返回补出的列名（前置步骤后撤掉）。 */
async function addMissingNodeColumns(db: Db): Promise<string[]> {
  const result = await db.execute(sql`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'approval_process_nodes'`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { column_name: string }[];
  const present = new Set(rows.map((r) => r.column_name));
  const missing = NODE_COLUMNS.filter(([name]) => !present.has(name));
  if (missing.length) {
    await db.execute(
      sql.raw(`ALTER TABLE approval_process_nodes ${missing.map(([n, t]) => `ADD COLUMN ${n} ${t}`).join(', ')}`),
    );
  }
  return missing.map(([name]) => name);
}

async function dropColumns(db: Db, names: readonly string[]) {
  if (!names.length) return;
  await db.execute(
    sql.raw(`ALTER TABLE approval_process_nodes ${names.map((name) => `DROP COLUMN ${name}`).join(', ')}`),
  );
}

export async function withPreAuditSchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const result = await db.execute(sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_events' AND column_name = 'scope_object') AS upgraded`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { upgraded: boolean }[];
  const nodeColumns = await addMissingNodeColumns(db);
  if (rows[0]?.upgraded) {
    try {
      return await run();
    } finally {
      await dropColumns(db, nodeColumns);
    }
  }
  await db.execute(
    sql.raw(`ALTER TABLE audit_events ${COLUMNS.map(([name, type]) => `ADD COLUMN ${name} ${type}`).join(', ')}`),
  );
  await db.execute(sql`CREATE FUNCTION current_tenant_timezone() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$ SELECT t.timezone FROM tenants t WHERE t.id = current_tenant_id() $$`);
  await db.execute(sql`GRANT EXECUTE ON FUNCTION current_tenant_timezone() TO app_user`);
  try {
    return await run();
  } finally {
    await db.execute(sql`DROP FUNCTION current_tenant_timezone()`);
    await db.execute(sql.raw(`ALTER TABLE audit_events ${COLUMNS.map(([name]) => `DROP COLUMN ${name}`).join(', ')}`));
    await dropColumns(db, nodeColumns);
  }
}
