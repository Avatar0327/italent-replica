/**
 * 事务级咨询锁的键构造（公共）。外部传入的租户 / 对象 UUID（如 X-Tenant-Id 请求头，按原样保留大小写）若直接拼进锁键文本，
 * 同一个对象的大小写变体会得到不同的锁、等于没有锁（PR #182 第 3 轮 P2-01；F-078 同类排查，DEC-374）。
 * 所以锁键里的每个 UUID 先转成 PostgreSQL 的 uuid 规范文本（小写、连字符）再拼接哈希；所有取同一把锁的入口都用本文件。
 * 键文本格式 = 各段依次拼接，与改造前的键一致（小写输入得到同一把锁，既有的屏障测试不受影响）。
 */
import type { SQL } from 'drizzle-orm';
import { sql, type Tx } from '@italent/db';

/** 锁键的一段：普通文本，或必须规范化的 UUID。 */
export type KeyPart = string | { readonly uuid: string };

/** 标记一段 UUID（取锁时在数据库里转规范文本；不是合法 UUID 时数据库报错，不会悄悄用原文）。 */
export const asUuid = (value: string): KeyPart => ({ uuid: value });

/** 64 位锁键：各段按顺序拼接后哈希。 */
export function lockKey(...parts: readonly KeyPart[]): SQL {
  const pieces = parts.map((part) => (typeof part === 'string' ? sql`${part}::text` : sql`(${part.uuid}::uuid)::text`));
  return sql`hashtextextended(${sql.join(pieces, sql` || `)}, 0)`;
}

/** 取事务级咨询锁（可能等待，事务结束释放）。 */
export async function advisoryLock(tx: Tx, ...parts: readonly KeyPart[]): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey(...parts)})`);
}

/** 试取事务级咨询锁：拿不到立即返回 false，从不等待。 */
export async function tryAdvisoryLock(tx: Tx, ...parts: readonly KeyPart[]): Promise<boolean> {
  const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${lockKey(...parts)}) AS entered`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { entered: boolean }[];
  return Boolean(rows[0]?.entered);
}
