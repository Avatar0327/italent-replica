/**
 * 凭据密钥运维命令的业务函数（F-076 设计 §2.4、§2.4.1）；命令行入口在 ops/survey360-credentials.ts。
 * - rotateKeys：在全局登记表登记一次密钥轮换（版本只增不减，与发放写回协调，见 credential-key-registry.ts），
 *   再为每个租户写一条 key_rotated 安全事件作审计（同版本重跑不重复写）；
 * - retireKeys：计划退役 / 泄露处置的持久落库清理，逐租户按链接行 ID 升序分批、每批一个事务、可续跑；
 *   泄露处置是否已生效不取决于它（配置部署即拒绝，PR-2a / 2b 读配置），它只负责把库里的摘要与会话清干净；
 * - credentialStats：按租户 / 活动统计仍以某版本存摘要的有效凭据数。
 * 输出（含手动重发清单）只有租户 / 活动 / 链接行 ID 与人数，不含任何凭据（DEC-379、DEC-377①：不自动群发）。
 */
import { randomUUID } from 'node:crypto';
import { type Db, pgErrorCode, sql, type Tx, withTenant } from '@italent/db';
import { credentialConfig, type CredentialConfig } from './credential-config.js';
import { registerKeyVersion } from './credential-key-registry.js';
import { tenantIds } from './credential-tenants.js';
import { recordSecurityEvent } from './security-events.js';
import { hasValidTask } from './tasks.js';

const RETIRE_BATCH = 500;

const rowsOf = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
const uuidList = (ids: readonly string[]) => `{${ids.join(',')}}`;

// ---- rotate ---------------------------------------------------------------------------------------------------
export interface RotateResult {
  readonly tenants: number;
  /** 本次新写的 key_rotated 事件数（该租户已有同版本事件的跳过）。 */
  readonly written: number;
}

export async function rotateKeys(
  db: Db,
  input: { readonly to: number; readonly config?: CredentialConfig; readonly clock?: () => Date },
): Promise<RotateResult> {
  const config = input.config ?? credentialConfig();
  const { to } = input;
  if (!config.credentialKeys.has(to) || to !== config.currentVersion) {
    throw new Error(
      `rotate：目标版本 ${to} 必须在 SURVEY360_CREDENTIAL_KEYS 里，且等于 SURVEY360_CREDENTIAL_KEY_CURRENT`,
    );
  }
  const now = (input.clock ?? (() => new Date()))();
  // 权威一步：全局登记（排他协调锁内只增不减），提交后旧版本的发放写回一律回滚（credential-key-registry.ts）
  const fallbackPrevious = Math.max(0, ...[...config.credentialKeys.keys()].filter((v) => v < to)) || null;
  const { previous } = await registerKeyVersion(db, { to, fallbackPrevious, now });

  // 审计：每个租户一条 key_rotated（不参与防回退判定）；重跑补齐缺的，已有的跳过
  const tenants = [];
  for await (const id of tenantIds(db)) tenants.push(id);
  let written = 0;
  for (const tenantId of tenants) {
    written += await withTenant(db, tenantId, async (tx) => {
      // 两位运维同时登记同一版本：按版本串行化“查有无事件 → 写事件”，后到者看到已有事件就跳过（P2-2）
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`survey360:key_rotated:${to}`}, 0))`);
      const [exists] = rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM survey360_security_events
          WHERE kind = 'key_rotated' AND credential_key_version = ${to}`),
      );
      if (exists && exists.n > 0) return 0;
      await recordSecurityEvent(tx, {
        tenantId,
        kind: 'key_rotated',
        occurredAt: now,
        credentialKeyVersion: to,
        detail: { previous },
      });
      return 1;
    });
  }
  return { tenants: tenants.length, written };
}

// ---- retire ---------------------------------------------------------------------------------------------------
export interface ResendGroup {
  readonly activityId: string;
  readonly linkIds: string[];
  readonly count: number;
}

export interface TenantRetire {
  readonly tenantId: string;
  readonly status: 'done' | 'failed';
  readonly credentials: number;
  readonly sessions: number;
  /** 需要管理员手动“重发邮件邀请”的评价者（链接未作废且仍有有效任务），不含凭据。 */
  readonly resend: ResendGroup[];
}

export interface RetireResult {
  readonly runId: string;
  readonly tenants: TenantRetire[];
}

export interface RetireInput {
  readonly version: number;
  readonly compromised: boolean;
  readonly config?: CredentialConfig;
  readonly batchSize?: number;
  /** 续跑：沿用该运行 ID，各租户从游标继续；已完成的租户直接返回首次结果。 */
  readonly resumeRunId?: string;
  readonly tenantId?: string;
  readonly clock?: () => Date;
  readonly hooks?: {
    readonly afterBatch?: (info: {
      tenantId: string;
      batch: number;
      credentials: number;
      sessions: number;
    }) => void | Promise<void>;
  };
}

interface RunRow {
  status: string;
  cursor_link_id: string | null;
  credentials_done: number;
  sessions_done: number;
  compromised: boolean;
  credential_key_version: number;
}

function assertRetirable(config: CredentialConfig, version: number, compromised: boolean): void {
  if (config.credentialKeys.has(version)) {
    throw new Error(`retire：版本 ${version} 仍在 SURVEY360_CREDENTIAL_KEYS 里，须先移入 RETIRED`);
  }
  if (!config.retiredVersions.has(version)) {
    throw new Error(`retire：版本 ${version} 不在 SURVEY360_CREDENTIAL_KEYS_RETIRED 里`);
  }
  if (compromised && !config.compromisedVersions.has(version)) {
    throw new Error(`retire --compromised：版本 ${version} 不在 SURVEY360_CREDENTIAL_KEYS_COMPROMISED 里`);
  }
}

/** 本批要处理的链接：计划退役 = 仍以该版本存摘要的 issued 行；泄露处置 = 曾用过该版本的行（不论状态）。 */
const batchQuery = (version: number, compromised: boolean, cursor: string | null, limit: number) => sql`
  SELECT id FROM survey360_links
  WHERE ${
    compromised
      ? sql`${version}::smallint = ANY(credential_key_versions)`
      : sql`credential_key_version = ${version} AND credential_state = 'issued'`
  } AND (${cursor}::uuid IS NULL OR id > ${cursor}::uuid)
  ORDER BY id LIMIT ${limit} FOR UPDATE`;

async function retireBatch(
  tx: Tx,
  tenantId: string,
  run: { runId: string; version: number; compromised: boolean },
  ids: string[],
  now: Date,
): Promise<{ credentials: number; sessions: number }> {
  const list = uuidList(ids);
  const retired = rowsOf<{ id: string }>(
    await tx.execute(sql`UPDATE survey360_links
      SET credential_state = 'retired', serial_lookup = NULL, password_hash = NULL
      WHERE id = ANY(${list}::uuid[]) AND credential_state = 'issued' RETURNING id`),
  );
  const revoked = run.compromised
    ? rowsOf<{ id: string }>(
        await tx.execute(sql`UPDATE survey360_answer_sessions SET revoked_at = ${now.toISOString()}::timestamptz
          WHERE link_id = ANY(${list}::uuid[]) AND revoked_at IS NULL RETURNING id`),
      )
    : [];
  await tx.execute(sql`UPDATE survey360_key_retire_runs
    SET cursor_link_id = ${ids.at(-1)}::uuid, credentials_done = credentials_done + ${retired.length},
        sessions_done = sessions_done + ${revoked.length}
    WHERE run_id = ${run.runId}::uuid`);
  await recordSecurityEvent(tx, {
    tenantId,
    kind: 'credential_revoked',
    occurredAt: now,
    runId: run.runId,
    credentialKeyVersion: run.version,
    compromised: run.compromised,
    detail: { credentials: retired.length, sessions: revoked.length },
  });
  return { credentials: retired.length, sessions: revoked.length };
}

async function resendList(tx: Tx, version: number, compromised: boolean): Promise<ResendGroup[]> {
  const found = rowsOf<{ activity_id: string; link_ids: string[] }>(
    await tx.execute(sql`SELECT l.activity_id, array_agg(l.id ORDER BY l.id) AS link_ids FROM survey360_links l
      WHERE l.kind = 'answer' AND l.credential_state = 'retired' AND NOT l.revoked
        AND ${
          compromised
            ? sql`${version}::smallint = ANY(l.credential_key_versions)`
            : sql`l.credential_key_version = ${version}`
        }
        AND ${hasValidTask(sql`l.activity_id`, sql`l.person_id`)}
      GROUP BY l.activity_id ORDER BY l.activity_id`),
  );
  return found.map((row) => ({ activityId: row.activity_id, linkIds: row.link_ids, count: row.link_ids.length }));
}

/**
 * 开始或接上一次运行：先 INSERT … ON CONFLICT DO NOTHING，再锁行读取，所以同一运行 ID 的两个进程同时启动也只有一行。
 * 进度（游标、计数、状态）只认这一行里持久化的值，不依赖进程内变量（P2-2）。
 */
async function loadOrStartRun(db: Db, tenantId: string, input: RetireInput, runId: string, now: Date) {
  return withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`INSERT INTO survey360_key_retire_runs
      (run_id, tenant_id, credential_key_version, compromised, status, started_at)
      VALUES (${runId}::uuid, ${tenantId}::uuid, ${input.version}, ${input.compromised}, 'running',
        ${now.toISOString()}::timestamptz)
      ON CONFLICT (tenant_id, run_id) DO NOTHING`);
    const [run] = rowsOf<RunRow>(
      await tx.execute(sql`SELECT status, cursor_link_id, credentials_done, sessions_done, compromised,
          credential_key_version FROM survey360_key_retire_runs WHERE run_id = ${runId}::uuid FOR UPDATE`),
    );
    if (!run) throw new Error('retire：运行行不存在');
    if (run.credential_key_version !== input.version || run.compromised !== input.compromised) {
      throw new Error('retire --resume：运行与给定的版本 / 泄露处置标志不一致');
    }
    if (run.status !== 'done') {
      await tx.execute(sql`UPDATE survey360_key_retire_runs SET status = 'running', error = NULL
        WHERE run_id = ${runId}::uuid`);
    }
    return run;
  });
}

/** 一批：先锁运行行并按持久游标取本批，所以并发的两个进程轮流推进，不会各用内存游标重复处理。 */
async function nextBatch(db: Db, tenantId: string, input: RetireInput, runId: string, now: Date, limit: number) {
  return withTenant(db, tenantId, async (tx) => {
    const [run] = rowsOf<{ status: string; cursor_link_id: string | null }>(
      await tx.execute(sql`SELECT status, cursor_link_id FROM survey360_key_retire_runs
        WHERE run_id = ${runId}::uuid FOR UPDATE`),
    );
    if (!run || run.status === 'done') return undefined;
    const ids = rowsOf<{ id: string }>(
      await tx.execute(batchQuery(input.version, input.compromised, run.cursor_link_id, limit)),
    ).map((row) => row.id);
    if (!ids.length) return undefined;
    return retireBatch(tx, tenantId, { runId, version: input.version, compromised: input.compromised }, ids, now);
  });
}

/** 收尾：锁运行行，已完成就跳过；否则标记完成并按持久进度写唯一的 key_retired（库里另有唯一索引兜底）。 */
async function finishRun(db: Db, tenantId: string, input: RetireInput, runId: string, now: Date) {
  return withTenant(db, tenantId, async (tx) => {
    const [run] = rowsOf<{ status: string; credentials_done: number; sessions_done: number }>(
      await tx.execute(sql`SELECT status, credentials_done, sessions_done FROM survey360_key_retire_runs
        WHERE run_id = ${runId}::uuid FOR UPDATE`),
    );
    if (!run) throw new Error('retire：运行行不存在');
    if (run.status !== 'done') {
      await tx.execute(sql`UPDATE survey360_key_retire_runs SET status = 'done', error = NULL,
        finished_at = ${now.toISOString()}::timestamptz WHERE run_id = ${runId}::uuid`);
      await recordSecurityEvent(tx, {
        tenantId,
        kind: 'key_retired',
        occurredAt: now,
        runId,
        credentialKeyVersion: input.version,
        compromised: input.compromised,
        detail: { credentials: run.credentials_done, sessions: run.sessions_done },
      });
    }
    return { credentials: run.credentials_done, sessions: run.sessions_done };
  });
}

async function retireTenant(db: Db, tenantId: string, input: RetireInput, runId: string, now: Date) {
  const batchSize = input.batchSize ?? RETIRE_BATCH;
  const run = await loadOrStartRun(db, tenantId, input, runId, now);
  if (run.status !== 'done') {
    try {
      for (let batch = 1; ; batch += 1) {
        const done = await nextBatch(db, tenantId, input, runId, now, batchSize);
        if (!done) break;
        await input.hooks?.afterBatch?.({ tenantId, batch, credentials: done.credentials, sessions: done.sessions });
      }
    } catch (error) {
      // 进度已按批持久；这里只记失败次数与错误码（不记消息文本），随后抛出让调用方看到。已完成的运行不被改回失败。
      await withTenant(db, tenantId, (tx) =>
        tx.execute(sql`UPDATE survey360_key_retire_runs SET status = 'failed', attempts = attempts + 1,
          error = ${pgErrorCode(error) ?? 'ERROR'} WHERE run_id = ${runId}::uuid AND status <> 'done'`),
      );
      throw error;
    }
  }
  const totals = await finishRun(db, tenantId, input, runId, now);
  const resend = await withTenant(db, tenantId, (tx) => resendList(tx, input.version, input.compromised));
  return { tenantId, status: 'done' as const, ...totals, resend };
}

export async function retireKeys(db: Db, input: RetireInput): Promise<RetireResult> {
  assertRetirable(input.config ?? credentialConfig(), input.version, input.compromised);
  const runId = input.resumeRunId ?? randomUUID();
  const now = (input.clock ?? (() => new Date()))();
  const tenants: TenantRetire[] = [];
  for await (const tenantId of tenantIds(db, input.tenantId)) {
    tenants.push(await retireTenant(db, tenantId, input, runId, now));
  }
  return { runId, tenants };
}

// ---- stats ----------------------------------------------------------------------------------------------------
export interface StatRow {
  readonly tenantId: string;
  readonly activityId: string;
  readonly count: number;
}

/** 仍以某版本存摘要的有效凭据（未作废、issued）数，按租户 / 活动；用来判断宽限期何时可以结束。 */
export async function credentialStats(db: Db, input: { readonly version: number }): Promise<StatRow[]> {
  const out: StatRow[] = [];
  for await (const tenantId of tenantIds(db)) {
    const found = await withTenant(db, tenantId, async (tx) =>
      rowsOf<{ activity_id: string; n: number }>(
        await tx.execute(sql`SELECT activity_id, count(*)::int AS n FROM survey360_links
          WHERE credential_key_version = ${input.version} AND credential_state = 'issued' AND NOT revoked
          GROUP BY activity_id ORDER BY activity_id`),
      ),
    );
    for (const row of found) out.push({ tenantId, activityId: row.activity_id, count: row.n });
  }
  return out;
}
