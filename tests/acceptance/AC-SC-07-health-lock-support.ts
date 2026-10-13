/** P3：用具体阻塞 PID 和等待 SQL 证明锁位置；不会把任意租户的 Lock 会话当作本次交错。 */
import { sql, type Db } from '@italent/db';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
export async function waitHealthLock(db: Db, blocker: number, table: 'org_settings' | 'succession_target_locks') {
  for (let i = 0; i < 200; i++) {
    const [waiting] = rowsOf<{ pid: number; query: string; locktype: string; mode: string }>(
      await db.execute(sql`SELECT a.pid,a.query,l.locktype,l.mode FROM pg_stat_activity a
        JOIN pg_locks l ON l.pid=a.pid AND NOT l.granted
        WHERE a.datname=current_database() AND a.wait_event_type='Lock'
        AND ${blocker}::int=ANY(pg_blocking_pids(a.pid)) AND a.query LIKE ${`%${table}%`}`),
    );
    if (waiting) return waiting;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`未发现 PID ${blocker} 阻塞 ${table} 的具体锁等待`);
}
