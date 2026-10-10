/**
 * 凭据密钥版本的全局登记与防回退（F-076 设计 §2.4“版本只增不减”）。
 *
 * 判定来源只有一个：平台表 survey360_credential_key_versions 的最大 version（全局，不按租户、不受租户 restoring 影响）。
 * 租户内的 key_rotated 安全事件仍照写，只作审计，不再参与判定（第 2 轮按租户事件判定，漏了新租户与恢复中的租户）。
 *
 * 发放与登记的协调（一把事务级 advisory lock，两种模式）：
 * - 发放写回：在写回事务里先取共享锁，再读最高版本，CURRENT 低于它就抛 KeyRollbackError，整笔回滚；
 * - 轮换登记：取同一把锁的排他模式后再读、再写登记行。
 * 于是登记会等所有已在进行的写回事务提交（它们以登记前的版本提交，是合法的）；登记一旦提交，此后开始的写回都读到新版本，
 * 旧版本凭据一条也提交不了。新写凭据的地方（含以后登录成功时升级摘要）都必须在写库的同一事务里调 assertIssuableVersion。
 */
import { type Db, sql, type Tx, withPlatform } from '@italent/db';
import type { CredentialConfig } from './credential-config.js';

const LOCK_KEY = 'survey360:credential_key_versions';

const rowsOf = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

export class KeyRollbackError extends Error {
  constructor(
    readonly registered: number,
    readonly current: number,
  ) {
    super(`凭据密钥版本回退：已登记轮换到版本 ${registered}，当前使用的版本是 ${current}（版本只增不减，设计 §2.4）`);
    this.name = 'KeyRollbackError';
  }
}

/** 已登记的最高版本；从未登记过为 0。 */
export async function registeredKeyVersion(tx: Tx): Promise<number> {
  const [row] = rowsOf<{ v: number | null }>(
    await tx.execute(sql`SELECT max(version)::int AS v FROM survey360_credential_key_versions`),
  );
  return row?.v ?? 0;
}

/** 某个已登记版本登记时记下的上一版本（同版本重跑 rotate 时沿用）。 */
async function previousOf(tx: Tx, version: number): Promise<number | null | undefined> {
  const [row] = rowsOf<{ previous: number | null }>(
    await tx.execute(sql`SELECT previous FROM survey360_credential_key_versions WHERE version = ${version}`),
  );
  return row ? row.previous : undefined;
}

/**
 * 发放写回事务的第一步：取协调锁（共享）后复核。必须在写凭据的同一事务里、写之前调用；锁持有到事务结束。
 * version 是这条凭据实际使用的密钥版本（生成时的 CURRENT），不是调用时重新读的配置。
 */
export async function assertIssuableVersion(tx: Tx, version: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${LOCK_KEY}, 0))`);
  const registered = await registeredKeyVersion(tx);
  if (registered > version) throw new KeyRollbackError(registered, version);
}

/**
 * 启动与维护任务入口的快速检查（平台事务，只读全局登记，不遍历租户）：CURRENT 低于已登记最高版本即拒绝。
 * 它只是尽早失败，不是协调边界；边界在 assertIssuableVersion。
 */
export async function assertNoKeyRollback(db: Db, config: CredentialConfig): Promise<void> {
  const registered = await withPlatform(db, registeredKeyVersion);
  if (registered > config.currentVersion) throw new KeyRollbackError(registered, config.currentVersion);
}

export interface Registration {
  /** 登记时的上一已登记版本；首次登记且配置里也没有更小的版本时为 null。 */
  readonly previous: number | null;
  /** 本次是否新写了登记行（同版本重跑为 false）。 */
  readonly created: boolean;
}

/**
 * 轮换登记（rotate 的权威一步，平台事务）：取协调锁（排他）→ 读最高版本 → 只增不减 → 写一行。
 * 目标等于已登记最高版本时视为重跑，不写、返回原 previous；低于它即拒绝。
 * fallbackPrevious：首次登记时还没有已登记版本，用配置里小于目标的最大版本作 previous（设计 §2.4.1）。
 */
export async function registerKeyVersion(
  db: Db,
  input: { readonly to: number; readonly fallbackPrevious: number | null; readonly now: Date },
): Promise<Registration> {
  return withPlatform(db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0))`);
    const registered = await registeredKeyVersion(tx);
    if (registered > input.to) {
      throw new Error(`rotate：目标版本 ${input.to} 必须不小于已登记的最高版本 ${registered}（版本只增不减）`);
    }
    if (registered === input.to) return { previous: (await previousOf(tx, input.to)) ?? null, created: false };
    const previous = registered || input.fallbackPrevious;
    await tx.execute(sql`INSERT INTO survey360_credential_key_versions (version, previous, registered_at)
      VALUES (${input.to}, ${previous}, ${input.now.toISOString()}::timestamptz)`);
    return { previous, created: true };
  });
}
