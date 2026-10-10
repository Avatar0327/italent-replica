/**
 * 事务级咨询锁的键构造（公共）。外部传入的租户 / 对象 UUID（如 X-Tenant-Id 请求头，按原样保留大小写）若直接拼进锁键文本，
 * 同一个对象的大小写变体会得到不同的锁、等于没有锁（PR #182 第 3 轮 P2-01；F-078 同类排查，DEC-374）。
 * 所以锁键里的每个 UUID 先转成 PostgreSQL 的 uuid 规范文本（小写、连字符）再拼接哈希；所有取同一把锁的入口都用本文件。
 * 键文本格式 = 各段依次拼接，**哈希算法也与改造前一致**：大多数取锁处原来用 64 位 hashtextextended（默认）；
 * qualification 原来用 32 位 hashtext，走 `hashtext32` 变体——换算法会让新旧进程混跑时全小写输入也拿不到同一把锁
 * （#195 第 1 轮 P2-01）。所以全小写输入下新旧键完全相同，只在旧进程传入非规范 UUID 文本时才不同。
 */
import type { SQL } from 'drizzle-orm';
import { sql, type Tx } from '@italent/db';

/** 锁键的一段：普通文本，或必须规范化的 UUID。 */
export type KeyPart = string | { readonly uuid: string };

/** 标记一段 UUID（取锁时在数据库里转规范文本；不是合法 UUID 时数据库报错，不会悄悄用原文）。 */
export const asUuid = (value: string): KeyPart => ({ uuid: value });

const joined = (parts: readonly KeyPart[]): SQL =>
  sql.join(
    parts.map((part) => (typeof part === 'string' ? sql`${part}::text` : sql`(${part.uuid}::uuid)::text`)),
    sql` || `,
  );

/** 64 位锁键：各段按顺序拼接后哈希。 */
export function lockKey(...parts: readonly KeyPart[]): SQL {
  return sql`hashtextextended(${joined(parts)}, 0)`;
}

/** 32 位锁键（hashtext）：只给改造前就用 hashtext 的取锁处，保持与旧进程同一把锁。 */
export function lockKey32(...parts: readonly KeyPart[]): SQL {
  return sql`hashtext(${joined(parts)})`;
}

/** 取事务级咨询锁（可能等待，事务结束释放）。 */
export async function advisoryLock(tx: Tx, ...parts: readonly KeyPart[]): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey(...parts)})`);
}

/** 同 advisoryLock，但用 32 位 hashtext（见 lockKey32）。 */
export async function advisoryLock32(tx: Tx, ...parts: readonly KeyPart[]): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey32(...parts)})`);
}

/** 试取事务级咨询锁：拿不到立即返回 false，从不等待。 */
export async function tryAdvisoryLock(tx: Tx, ...parts: readonly KeyPart[]): Promise<boolean> {
  const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${lockKey(...parts)}) AS entered`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { entered: boolean }[];
  return Boolean(rows[0]?.entered);
}
