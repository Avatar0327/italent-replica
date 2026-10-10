/**
 * 字段目录版本（F-082 契约 §1.3、§3.4）：字段“名称 → ID”映射的版本，每租户一行（talent_review_field_catalog_versions）。
 * 凡是新增 / 删除字段行或改变字段名称的写入，都在同一事务里经 bumpFieldCatalog 推进它（停用不改变名称映射，不推进）：
 * - 调用时机在事务里所有其他锁（R、A、F）都已取得之后——它是全局锁序里的 V（S < R < A < F < V < I），V 之后只允许再取计算项目行；
 * - 新值 = greatest(version + 1, 当前毫秒时间戳)，租户恢复后也不会回到客户端手里已有的旧值；
 * - 版本行不存在时先 INSERT … ON CONFLICT DO NOTHING 再加锁，避免首次写入竞态；
 * - 一个事务最多推进一次；以后新增的字段写入口一律经这里（AC-26 的源码扫描会拦住绕开它的调用点）。
 */
import { eq, sql, talentReviewFieldCatalogVersions as V, type Tx } from '@italent/db';

/** 每个事务对每个租户只推进一次。 */
const BUMPED = new WeakMap<object, Set<string>>();

async function ensureRow(tx: Tx, tenantId: string): Promise<void> {
  await tx.insert(V).values({ tenantId }).onConflictDoNothing();
}

/** 版本行 FOR UPDATE（全租户的新建、改名、删除在这一行上串行）；返回当前版本。 */
export async function lockFieldCatalog(tx: Tx, tenantId: string): Promise<number> {
  await ensureRow(tx, tenantId);
  const [row] = await tx.select({ version: V.version }).from(V).where(eq(V.tenantId, tenantId)).for('update');
  return row!.version;
}

/** 推进字段目录版本；返回新值。同一事务内重复调用只推进一次。 */
export async function bumpFieldCatalog(tx: Tx, tenantId: string): Promise<number> {
  await ensureRow(tx, tenantId);
  const done = BUMPED.get(tx) ?? new Set<string>();
  const [row] = await tx
    .update(V)
    .set({
      version: done.has(tenantId)
        ? V.version
        : sql`greatest(${V.version} + 1, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)`,
    })
    .where(eq(V.tenantId, tenantId))
    .returning({ version: V.version });
  done.add(tenantId);
  BUMPED.set(tx, done);
  return row!.version;
}
