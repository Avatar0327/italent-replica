/**
 * 通用网址登录的防暴力限频（F-076 设计 §3，方案 C，DEC-379③）。限频行存 survey360_login_throttle，键只存 HMAC：
 * - ip（D1）：每 IP 每 15 分钟固定窗口至多 3000 次登录请求（成功、失败都计），超限 429 REQUEST_RATE_LIMITED；
 * - pair（D3）：序列号 × IP，每 15 分钟固定窗口失败 5 次锁 15 分钟，429 AUTH_LOCKED；
 * - tenant（D5）：租户失败 15 分钟 300 次只告警，不拒绝（任何不含 IP 的拒绝维度都能被用来封禁不相关的人，§3.4）。
 * 窗口与锁定的统一语义见 §3.3；取锁顺序固定为 IP 行 → 序列号 × IP 行 → 链接行（portal.ts 的 T2 最后锁链接行），
 * 租户行永远最后、只用单条 upsert。
 */
import { createHmac } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import type { CredentialConfig } from './credential-config.js';
import { rows } from './context.js';
import { recordSecurityEvent } from './security-events.js';

/** 阈值是常量（设计 §3.2），不做租户配置。 */
export const WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 15 * 60_000;
export const IP_REQUEST_LIMIT = 3000;
export const PAIR_FAILURE_LIMIT = 5;
export const TENANT_FAILURE_ALERT = 300;

const hmac = (config: Pick<CredentialConfig, 'throttleKey'>, label: string, ...parts: string[]) =>
  createHmac('sha256', config.throttleKey).update(label).update(parts.join('\0')).digest('hex');

/** bucket = client-ip.ts 的限频桶（IPv4 地址 / IPv6 /64 / unknown）。 */
export const ipKey = (config: Pick<CredentialConfig, 'throttleKey'>, bucket: string) => hmac(config, 'ip:', bucket);
export const pairKey = (config: Pick<CredentialConfig, 'throttleKey'>, normalizedSerial: string, bucket: string) =>
  hmac(config, 'pair:', normalizedSerial, bucket);

interface Counter {
  readonly windowStartedAt: Date;
  readonly requests: number;
  readonly failures: number;
  readonly lockedUntil: Date | null;
}

interface ThrottleRow {
  window_started_at: Date | string;
  requests: number;
  failures: number;
  locked_until: Date | string | null;
}

export type Rejection =
  | { readonly kind: 'rate'; readonly retryAfter: number }
  | { readonly kind: 'locked'; readonly retryAfter: number; readonly unlockAt: Date };

const seconds = (until: Date, now: Date) => Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
const fresh = (now: Date): Counter => ({ windowStartedAt: now, requests: 0, failures: 0, lockedUntil: null });
const toCounter = (row: ThrottleRow): Counter => ({
  windowStartedAt: new Date(row.window_started_at),
  requests: row.requests,
  failures: row.failures,
  lockedUntil: row.locked_until === null ? null : new Date(row.locked_until),
});

interface Verdict {
  /** 内存里按 §3.3 处理后的值（可能已重置窗口）；放行后的预扣以它为基数。 */
  readonly counter: Counter;
  readonly rejection?: Rejection;
  /** 已到期但未清的锁定（视为已解锁，需写 unlock 并清掉 locked_until）。 */
  readonly expiredLock?: Date;
}

/** §3.3：锁定中 / 锁定已到期 / 窗口过期 / 窗口内已达阈值但未锁 / 放行。 */
function judge(row: Counter | undefined, now: Date, scope: 'ip' | 'pair'): Verdict {
  const counter = row ?? fresh(now);
  if (counter.lockedUntil && counter.lockedUntil > now) {
    return {
      counter,
      rejection: { kind: 'locked', retryAfter: seconds(counter.lockedUntil, now), unlockAt: counter.lockedUntil },
    };
  }
  const expiredLock = counter.lockedUntil ?? undefined;
  const base = { ...counter, lockedUntil: null };
  const windowEnd = new Date(base.windowStartedAt.getTime() + WINDOW_MS);
  if (windowEnd <= now) return { counter: fresh(now), ...(expiredLock ? { expiredLock } : {}) };
  const extra = expiredLock ? { expiredLock } : {};
  if (scope === 'ip' && base.requests >= IP_REQUEST_LIMIT) {
    return { counter: base, rejection: { kind: 'rate', retryAfter: seconds(windowEnd, now) }, ...extra };
  }
  if (scope === 'pair' && base.failures >= PAIR_FAILURE_LIMIT) {
    return {
      counter: base,
      rejection: { kind: 'locked', retryAfter: seconds(windowEnd, now), unlockAt: windowEnd },
      ...extra,
    };
  }
  return { counter: base, ...extra };
}

async function selectRow(tx: Tx, tenantId: string, scope: string, key: string): Promise<Counter | undefined> {
  const [row] = rows<ThrottleRow>(
    await tx.execute(sql`SELECT window_started_at, requests, failures, locked_until FROM survey360_login_throttle
      WHERE tenant_id = ${tenantId}::uuid AND scope = ${scope} AND key_hash = ${key} FOR UPDATE`),
  );
  return row ? toCounter(row) : undefined;
}

/** 到期的锁视为已解锁：立即清空 locked_until（清理，不是计数）并写 unlock；同一把锁因此只记一次。 */
async function clearExpiredLock(tx: Tx, tenantId: string, scope: string, key: string, at: Date, now: Date) {
  const stamp = now.toISOString();
  await tx.execute(sql`UPDATE survey360_login_throttle SET locked_until = NULL, updated_at = ${stamp}::timestamptz
    WHERE tenant_id = ${tenantId}::uuid AND scope = ${scope} AND key_hash = ${key}`);
  await recordSecurityEvent(tx, {
    tenantId,
    kind: 'unlock',
    occurredAt: now,
    scope,
    keyPrefix: key.slice(0, 8),
    detail: { unlockedAt: at.toISOString() },
  });
}

export interface AdmitInput<T> {
  readonly tenantId: string;
  readonly now: Date;
  readonly ipKey: string;
  readonly pairKey: string;
  /** 凭据查找（§3.5 第 2d 步）：放行后、预扣前在同一事务里执行，找到 / 找不到走同一条索引路径。 */
  readonly lookup: (tx: Tx) => Promise<T>;
}

export type Admission<T> =
  | { readonly ok: false; readonly rejection: Rejection }
  | { readonly ok: true; readonly found: T; readonly pairMark: Date };

/**
 * T1 原子检查与预扣（短事务，不做 KDF）：按 IP 行 → 序列号 × IP 行的顺序加锁并判定；任一拒绝则不写任何计数、
 * 不新建行（只可能清掉已到期的锁并写 unlock）；全部放行才一起预扣，返回预扣标识（序列号 × IP 行的 window_started_at；成功退回只退这一行，IP 行 requests 不退）。
 */
export async function admit<T>(tx: Tx, input: AdmitInput<T>): Promise<Admission<T>> {
  const { tenantId, now } = input;
  const at = now.toISOString();
  await tx.execute(sql`INSERT INTO survey360_login_throttle (tenant_id, scope, key_hash, window_started_at, updated_at)
    VALUES (${tenantId}::uuid, 'ip', ${input.ipKey}, ${at}::timestamptz, ${at}::timestamptz)
    ON CONFLICT (tenant_id, scope, key_hash) DO NOTHING`);
  const ip = judge(await selectRow(tx, tenantId, 'ip', input.ipKey), now, 'ip');
  if (ip.expiredLock) await clearExpiredLock(tx, tenantId, 'ip', input.ipKey, ip.expiredLock, now);
  if (ip.rejection) return { ok: false, rejection: ip.rejection };

  const pair = judge(await selectRow(tx, tenantId, 'pair', input.pairKey), now, 'pair');
  if (pair.expiredLock) await clearExpiredLock(tx, tenantId, 'pair', input.pairKey, pair.expiredLock, now);
  if (pair.rejection) return { ok: false, rejection: pair.rejection };

  const found = await input.lookup(tx);
  const ipWindow = ip.counter.windowStartedAt.toISOString();
  await tx.execute(sql`UPDATE survey360_login_throttle SET window_started_at = ${ipWindow}::timestamptz,
      requests = ${ip.counter.requests + 1}, locked_until = NULL, updated_at = ${at}::timestamptz
    WHERE tenant_id = ${tenantId}::uuid AND scope = 'ip' AND key_hash = ${input.ipKey}`);
  await tx.execute(sql`INSERT INTO survey360_login_throttle
      (tenant_id, scope, key_hash, window_started_at, failures, updated_at)
    VALUES (${tenantId}::uuid, 'pair', ${input.pairKey}, ${pair.counter.windowStartedAt.toISOString()}::timestamptz,
      ${pair.counter.failures + 1}, ${at}::timestamptz)
    ON CONFLICT (tenant_id, scope, key_hash) DO UPDATE SET window_started_at = EXCLUDED.window_started_at,
      failures = EXCLUDED.failures, locked_until = NULL, updated_at = EXCLUDED.updated_at`);
  return { ok: true, found, pairMark: pair.counter.windowStartedAt };
}

/** T2 取锁：IP 行 → 序列号 × IP 行（链接行由调用方最后锁）。行不存在（被清理）时无事可做。 */
export async function lockRows(tx: Tx, tenantId: string, keys: { ip: string; pair: string }): Promise<void> {
  await selectRow(tx, tenantId, 'ip', keys.ip);
  await selectRow(tx, tenantId, 'pair', keys.pair);
}

/** 成功：退回预扣（序列号 × IP 行失败清零），带条件 window_started_at = 预扣标识；IP 行 requests 不退。 */
export async function refundPair(tx: Tx, tenantId: string, key: string, mark: Date, now: Date): Promise<void> {
  await tx.execute(sql`UPDATE survey360_login_throttle SET failures = 0, updated_at = ${now.toISOString()}::timestamptz
    WHERE tenant_id = ${tenantId}::uuid AND scope = 'pair' AND key_hash = ${key}
      AND window_started_at = ${mark.toISOString()}::timestamptz`);
}

/** 失败：预扣即确认；失败数达阈值（且窗口仍是预扣标识）则锁 15 分钟、重置窗口，写 lock 事件。 */
export async function confirmFailure(tx: Tx, tenantId: string, key: string, mark: Date, now: Date): Promise<void> {
  const row = await selectRow(tx, tenantId, 'pair', key);
  if (!row || row.windowStartedAt.getTime() !== mark.getTime() || row.failures < PAIR_FAILURE_LIMIT) return;
  const lockedUntil = new Date(now.getTime() + LOCK_MS);
  const at = now.toISOString();
  await tx.execute(sql`UPDATE survey360_login_throttle SET locked_until = ${lockedUntil.toISOString()}::timestamptz,
      failures = 0, window_started_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
    WHERE tenant_id = ${tenantId}::uuid AND scope = 'pair' AND key_hash = ${key}`);
  await recordSecurityEvent(tx, {
    tenantId,
    kind: 'lock',
    occurredAt: now,
    scope: 'pair',
    keyPrefix: key.slice(0, 8),
    detail: { lockedUntil: lockedUntil.toISOString() },
  });
}

/** D5：租户失败数 +1（单条 upsert，最后一步）；返回窗口内累计失败数，调用方在恰好跨过 300 时告警。 */
export async function recordTenantFailure(tx: Tx, tenantId: string, now: Date): Promise<number> {
  const at = now.toISOString();
  const window = `${WINDOW_MS / 1000} seconds`;
  const expired = sql`survey360_login_throttle.window_started_at + ${window}::interval <= ${at}::timestamptz`;
  const [row] = rows<{ failures: number }>(
    await tx.execute(sql`INSERT INTO survey360_login_throttle
        (tenant_id, scope, key_hash, window_started_at, failures, updated_at)
      VALUES (${tenantId}::uuid, 'tenant', '', ${at}::timestamptz, 1, ${at}::timestamptz)
      ON CONFLICT (tenant_id, scope, key_hash) DO UPDATE SET
        failures = CASE WHEN ${expired}
          THEN 1 ELSE survey360_login_throttle.failures + 1 END,
        window_started_at = CASE WHEN ${expired}
          THEN ${at}::timestamptz ELSE survey360_login_throttle.window_started_at END,
        updated_at = ${at}::timestamptz
      RETURNING failures`),
  );
  return row!.failures;
}
