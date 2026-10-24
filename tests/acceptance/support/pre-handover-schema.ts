/**
 * 升级测试夹具（R2 BE-8b2，DEC-663）：当前保存审批流程定义的代码会写节点的兜底处理人列（approval_process_nodes.fallback_user_ids），
 * 它在迁移 be8b2_handover_fallback 才加。在更早的结构上用当前接口 / 夹具建流程时，临时补出这一列，前置步骤跑完即撤掉，
 * 再由测试执行升级迁移按正式结构加上——同 pre-blacklist-schema 等先例。生产总是先迁移再服务，生产代码不判断列是否存在（DEC-402）。
 */
import { type Db, sql } from '@italent/db';

export async function withPreHandoverSchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const result = await db.execute(sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_process_nodes' AND column_name = 'fallback_user_ids') AS present`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { present: boolean }[];
  if (rows[0]?.present) return run();
  await db.execute(sql`ALTER TABLE approval_process_nodes ADD COLUMN fallback_user_ids uuid[] NOT NULL DEFAULT '{}'`);
  try {
    return await run();
  } finally {
    await db.execute(sql`ALTER TABLE approval_process_nodes DROP COLUMN fallback_user_ids`);
  }
}
