/**
 * 凭据维护任务 survey360-credential-maintenance（F-076 设计 §2.5；DEC-052、DEC-379① 异步发放）。
 * 1. 认领（短事务）：pending 且未被认领（或认领已超 5 分钟）的链接行，每批 ≤ 100，FOR UPDATE SKIP LOCKED；
 * 2. 生成与 KDF（事务外）：并发 ≤ 2，命令事务里永远没有 KDF；
 * 3. 写回（每行一个短事务）：按认领时间 CAS 写摘要并改 issued，同事务把序列号与密码加进邀请 outbox 的 sealed（换新 IV）、
 *    邀请转 pending、写 credential_issued；CAS 失败（期间被重发作废或被别的进程重领）丢弃本次明文；
 *    序列号唯一冲突 → attempts + 1，释放认领，下一轮换新值；连续 5 次写运行日志，不自动放弃；
 * 4. 同一任务还清理过期会话与空闲限频行，并把到期未清的锁定记为 unlock 事件。
 * 进程在第 2、3 步之间崩溃：明文只在内存里，库里仍是 pending，认领过期后下一轮重领生成新值，不会出现两组凭据。
 * outbox 的 sealed 清理不在这里，归 F-077。
 */
import { type Db, pgErrorCode, sql, survey360Links, survey360Outbox, type Tx, withTenant } from '@italent/db';
import { and, eq } from '@italent/db';
import { credentialConfig, type CredentialConfig } from './credential-config.js';
import { tenantIds } from './credential-tenants.js';
import { makeCredential } from './credentials.js';
import { openSealed, sealJson, type Sealed } from './secret-box.js';
import { recordSecurityEvent } from './security-events.js';

const BATCH_SIZE = 100;
const MAX_BATCHES = 1000;
const KDF_CONCURRENCY = 2;
const CLAIM_TTL_MS = 5 * 60_000;
const STALE_PENDING_MS = 60 * 60_000;
const FAILING_ATTEMPTS = 5;
const SESSION_REVOKED_KEEP_MS = 24 * 3_600_000;
const THROTTLE_IDLE_MS = 24 * 3_600_000;
const CLEANUP_LIMIT = 5000;

export interface MaintenanceHooks {
  /** 生成并做完 KDF、写回之前（测试用来模拟崩溃）。 */
  readonly beforeWriteBack?: (linkId: string) => void | Promise<void>;
  /** 结构化运行日志（缺省 console.warn 一行 JSON）；数据里只放计数与 ID，不放明文。 */
  readonly warn?: (message: string, data: Record<string, unknown>) => void;
}

export interface MaintenanceOptions {
  readonly clock?: () => Date;
  /** 只处理一个租户。 */
  readonly tenantId?: string;
  readonly batchSize?: number;
  readonly kdfConcurrency?: number;
  /** 序列号 / 密码的随机源（测试注入以构造冲突）；缺省 crypto.randomInt。 */
  readonly random?: (maxExclusive: number) => number;
  readonly config?: CredentialConfig;
  readonly hooks?: MaintenanceHooks;
}

export interface MaintenanceReport {
  issued: number;
  conflicts: number;
  /** 写回时认领已失效（被重发作废或被别的进程重领）而丢弃的行数。 */
  lost: number;
  batches: number[];
  sessionsDeleted: number;
  throttleDeleted: number;
  unlocked: number;
}

interface Claimed {
  readonly id: string;
  readonly activityId: string;
  readonly claimedAt: Date;
}

const rowsOf = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

/** 受影响行数：postgres-js 是 count，PGlite 是 affectedRows。 */
const affected = (result: unknown): number => {
  const r = result as { count?: number; rowCount?: number; affectedRows?: number };
  return r.count ?? r.rowCount ?? r.affectedRows ?? 0;
};

const defaultWarn = (message: string, data: Record<string, unknown>) =>
  console.warn(JSON.stringify({ level: 'warn', message, ...data }));

async function claim(
  tenantId: string,
  db: Db,
  now: Date,
  limit: number,
  skip: ReadonlySet<string>,
): Promise<Claimed[]> {
  const stale = new Date(now.getTime() - CLAIM_TTL_MS);
  return withTenant(db, tenantId, async (tx) => {
    const picked = rowsOf<{ id: string; activity_id: string }>(
      await tx.execute(sql`SELECT id, activity_id FROM survey360_links
        WHERE credential_state = 'pending' AND NOT revoked
          AND (credential_claimed_at IS NULL OR credential_claimed_at < ${stale.toISOString()}::timestamptz)
          AND NOT (id = ANY(${`{${[...skip].join(',')}}`}::uuid[]))
        ORDER BY created_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED`),
    );
    if (!picked.length) return [];
    await tx.execute(sql`UPDATE survey360_links SET credential_claimed_at = ${now.toISOString()}::timestamptz
      WHERE id = ANY(${`{${picked.map((p) => p.id).join(',')}}`}::uuid[])`);
    return picked.map((p) => ({ id: p.id, activityId: p.activity_id, claimedAt: now }));
  });
}

type WriteBack = 'issued' | 'lost';

/** 写回一行：CAS 更新链接 → 解封并重新封装邀请 → 邀请转 pending → credential_issued；同一事务。 */
async function writeBack(
  tx: Tx,
  tenantId: string,
  row: Claimed,
  credential: Awaited<ReturnType<typeof makeCredential>>,
  config: CredentialConfig,
  now: Date,
): Promise<WriteBack> {
  const [updated] = await tx
    .update(survey360Links)
    .set({
      serialLookup: credential.serialLookup,
      passwordHash: credential.passwordHash,
      credentialState: 'issued',
      credentialKeyVersion: credential.version,
      credentialKeyVersions: [credential.version],
      credentialError: null,
    })
    .where(
      and(
        eq(survey360Links.id, row.id),
        eq(survey360Links.credentialState, 'pending'),
        eq(survey360Links.revoked, false),
        eq(survey360Links.credentialClaimedAt, row.claimedAt),
      ),
    )
    .returning({ id: survey360Links.id });
  if (!updated) return 'lost';

  const [mail] = rowsOf<{ id: string; event_type: string; payload: Record<string, unknown> }>(
    await tx.execute(sql`SELECT id, event_type, payload FROM survey360_outbox
      WHERE event_type = 'survey360.answer_invitation' AND payload->>'linkId' = ${row.id}
        AND state = 'awaiting_credential' FOR UPDATE`),
  );
  if (!mail) throw new Error('凭据发放：链接没有等待中的邀请');
  const where = { tenantId, outboxId: mail.id, eventType: mail.event_type };
  const opened = openSealed(config, mail.payload['sealed'] as Sealed, where);
  const sealed = sealJson(config, { ...opened, serial: credential.serial, password: credential.password }, where);
  await tx
    .update(survey360Outbox)
    .set({ payload: { ...mail.payload, sealed }, state: 'pending' })
    .where(eq(survey360Outbox.id, mail.id));
  await recordSecurityEvent(tx, {
    tenantId,
    kind: 'credential_issued',
    occurredAt: now,
    linkId: row.id,
    activityId: row.activityId,
    credentialKeyVersion: credential.version,
  });
  return 'issued';
}

/** 失败记录：attempts + 1、只存错误码、释放认领（认领时间对得上才改，避免覆盖别的进程的认领）。返回新的失败次数。 */
async function recordFailure(db: Db, tenantId: string, row: Claimed, code: string): Promise<number | undefined> {
  return withTenant(db, tenantId, async (tx) => {
    const [updated] = rowsOf<{ attempts: number }>(
      await tx.execute(sql`UPDATE survey360_links SET credential_attempts = credential_attempts + 1,
          credential_error = ${code}, credential_claimed_at = NULL
        WHERE id = ${row.id}::uuid AND credential_state = 'pending'
          AND credential_claimed_at = ${row.claimedAt.toISOString()}::timestamptz
        RETURNING credential_attempts AS attempts`),
    );
    return updated?.attempts;
  });
}

async function pool<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function warnStale(db: Db, tenantId: string, now: Date, warn: NonNullable<MaintenanceHooks['warn']>) {
  const cutoff = new Date(now.getTime() - STALE_PENDING_MS);
  const [row] = await withTenant(db, tenantId, async (tx) =>
    rowsOf<{ count: number }>(
      await tx.execute(sql`SELECT count(*)::int AS count FROM survey360_links
        WHERE credential_state = 'pending' AND NOT revoked AND created_at < ${cutoff.toISOString()}::timestamptz`),
    ),
  );
  if (row && row.count > 0) warn('survey360.credential.pending_stale', { tenantId, count: row.count });
}

async function issueTenant(db: Db, tenantId: string, options: MaintenanceOptions, report: MaintenanceReport) {
  const config = options.config ?? credentialConfig();
  const now = (options.clock ?? (() => new Date()))();
  const hooks = options.hooks ?? {};
  const warn = hooks.warn ?? defaultWarn;
  await warnStale(db, tenantId, now, warn);
  // 本轮失败的行（冲突 / 写回出错）已释放认领，但留到下一轮再试，否则同一轮会反复重领
  const failed = new Set<string>();
  for (let round = 0; round < MAX_BATCHES; round += 1) {
    const claimed = await claim(tenantId, db, now, options.batchSize ?? BATCH_SIZE, failed);
    if (!claimed.length) return;
    report.batches.push(claimed.length);
    await pool(claimed, options.kdfConcurrency ?? KDF_CONCURRENCY, async (row) => {
      const credential = await makeCredential(config, options.random);
      await hooks.beforeWriteBack?.(row.id);
      try {
        const outcome = await withTenant(db, tenantId, (tx) => writeBack(tx, tenantId, row, credential, config, now));
        if (outcome === 'issued') report.issued += 1;
        else report.lost += 1;
      } catch (error) {
        const code = pgErrorCode(error) === '23505' ? 'SERIAL_CONFLICT' : 'WRITE_FAILED';
        failed.add(row.id);
        const attempts = await recordFailure(db, tenantId, row, code);
        report.conflicts += 1;
        if (attempts !== undefined && attempts >= FAILING_ATTEMPTS) {
          warn('survey360.credential.issue_failing', { tenantId, linkId: row.id, attempts, code });
        }
      }
    });
  }
}

/** 清理：到期未清的锁定记 unlock、删空闲限频行、删过期 / 作废超过 24 小时的会话（设计 §3.2、§4.1、§5.4）。 */
async function cleanupTenant(db: Db, tenantId: string, now: Date, report: MaintenanceReport) {
  const at = now.toISOString();
  await withTenant(db, tenantId, async (tx) => {
    const expired = rowsOf<{ scope: string; key_hash: string; locked_until: Date | string }>(
      await tx.execute(sql`SELECT scope, key_hash, locked_until FROM survey360_login_throttle
        WHERE locked_until IS NOT NULL AND locked_until <= ${at}::timestamptz
        ORDER BY locked_until LIMIT ${CLEANUP_LIMIT} FOR UPDATE`),
    );
    for (const lock of expired) {
      await recordSecurityEvent(tx, {
        tenantId,
        kind: 'unlock',
        occurredAt: now,
        scope: lock.scope,
        keyPrefix: lock.key_hash.slice(0, 8),
        detail: { unlockedAt: new Date(lock.locked_until).toISOString() },
      });
      await tx.execute(sql`UPDATE survey360_login_throttle SET locked_until = NULL, updated_at = ${at}::timestamptz
        WHERE scope = ${lock.scope} AND key_hash = ${lock.key_hash}`);
    }
    report.unlocked += expired.length;
    const idle = new Date(now.getTime() - THROTTLE_IDLE_MS).toISOString();
    const throttle = await tx.execute(sql`DELETE FROM survey360_login_throttle
      WHERE locked_until IS NULL AND updated_at < ${idle}::timestamptz`);
    report.throttleDeleted += affected(throttle);
    const kept = new Date(now.getTime() - SESSION_REVOKED_KEEP_MS).toISOString();
    const sessions = await tx.execute(sql`DELETE FROM survey360_answer_sessions
      WHERE expires_at < ${at}::timestamptz OR (revoked_at IS NOT NULL AND revoked_at < ${kept}::timestamptz)`);
    report.sessionsDeleted += affected(sessions);
  });
}

/** 跑一轮（所有启用 / 停用租户，或 options.tenantId）。可重复执行；多实例靠 SKIP LOCKED 与认领 CAS 去重。 */
export async function runCredentialMaintenance(db: Db, options: MaintenanceOptions = {}): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    issued: 0,
    conflicts: 0,
    lost: 0,
    batches: [],
    sessionsDeleted: 0,
    throttleDeleted: 0,
    unlocked: 0,
  };
  const now = (options.clock ?? (() => new Date()))();
  for await (const tenantId of tenantIds(db, options.tenantId)) {
    await issueTenant(db, tenantId, options, report);
    await cleanupTenant(db, tenantId, now, report);
  }
  return report;
}

export interface CredentialMaintenanceScheduler {
  stop(): Promise<void>;
}

/** 进程内调度：每个间隔跑一轮；上一轮未结束时不叠加。出错只上报，下一轮重试（DEC-052）。 */
export function startCredentialMaintenanceScheduler(
  db: Db,
  options: {
    readonly intervalMs?: number;
    readonly clock?: () => Date;
    readonly onError?: (error: unknown) => void;
  } = {},
): CredentialMaintenanceScheduler {
  const intervalMs = options.intervalMs ?? 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000)
    throw new RangeError('凭据维护间隔须为不小于 1000 的毫秒数');
  const onError = options.onError ?? ((error: unknown) => console.error('凭据维护任务运行失败', error));
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = runCredentialMaintenance(db, options.clock ? { clock: options.clock } : {})
      .then(() => undefined)
      .catch(onError)
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
