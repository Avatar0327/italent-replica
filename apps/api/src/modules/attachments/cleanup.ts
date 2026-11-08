/**
 * F-479 S3 过期清理（设计 §2.5）：
 * - expire：registered / uploaded 且过期（expires_at 早于现在；registered 没有 expires_at，按登记时间 + 用途 TTL）→ pending_cleanup；
 * - purge：pending_cleanup 且满 1 小时宽限、从未封存 → 删除字节行，元数据置 purged（保留作快照）。
 * 已绑定 / 已封存 / detached 的文件不在任何候选条件里；恢复校验隔离件（pending_cleanup 且 cleanup_at 为空）
 * 不论是否封存都不自动删字节，留待人工核对（§2.3、§2.6）。
 * 每条一个小事务（行锁 SKIP LOCKED + 复核状态），失败回滚后另开事务记 attachment_cleanup_attempts，不影响其他条；
 * 状态推进后文件不再是候选，所以重复执行无额外变化（AGENTS §10 定时任务：可重复执行，失败记次数与原因）。
 */
import {
  attachmentCleanupAttempts as A,
  attachmentFiles as F,
  and,
  eq,
  sql,
  withTenant,
  type Db,
  type Tx,
} from '@italent/db';
import { ATTACHMENT_PURPOSES, tenantLocalDate } from '@italent/domain';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { AppError } from '../../errors.js';
import { activeTenants, type TenantRow } from '../employment/active-tenants.js';
import { rowsOf } from '../employment/record-store.js';
import { PgBlobStore, type AttachmentBlobStore } from './blob-store.js';
import { record, type FileRow } from './audit.js';

const HOUR = 3_600_000;
/** 待清理宽限：只为让并发中的读取请求自然失败而非读到半删状态（设计 §2.5）。 */
export const ATTACHMENT_PURGE_GRACE_HOURS = 1;
/** 每租户每轮最多处理条数（有界，设计 §2.5）。 */
export const ATTACHMENT_CLEANUP_LIMIT = 500;

export type CleanupKind = 'expire' | 'purge';

export interface CleanupInput {
  readonly db: Db;
  readonly clock: () => Date;
  /** 只清理这一个租户；缺省时列出全部活跃租户逐个处理。 */
  readonly tenantId?: string;
  /** 字节存储端口；测试注入异常，缺省走 PgBlobStore。 */
  readonly store?: AttachmentBlobStore;
  /** 每租户本轮上限，1～500。 */
  readonly limit?: number;
}
export interface CleanupOutcome {
  readonly fileId: string;
  readonly kind: CleanupKind;
  readonly state: 'succeeded' | 'failed';
  readonly error?: string;
}
export interface CleanupRun {
  readonly tenantId: string;
  readonly outcomes: readonly CleanupOutcome[];
}
type Tenant = TenantRow;

/** registered 没有 expires_at：按登记时间 + 用途 TTL 折算；purpose 取自受 CHECK 约束的已登记用途。 */
const registeredExpiry = (f: ReturnType<typeof sql.raw>) =>
  sql`CASE ${f}.purpose ${sql.join(
    Object.entries(ATTACHMENT_PURPOSES).map(
      ([code, config]) => sql`WHEN ${code} THEN ${f}.created_at + make_interval(hours => ${config.tempTtlHours})`,
    ),
    sql` `,
  )} END`;

function expiryOf(row: FileRow): Date | null {
  if (row.expiresAt) return row.expiresAt;
  const config = ATTACHMENT_PURPOSES[row.purpose as keyof typeof ATTACHMENT_PURPOSES];
  return config ? new Date(row.createdAt.getTime() + config.tempTtlHours * HOUR) : null;
}

/** 行锁内复核：候选查询与加锁之间状态可能已被本人操作或另一实例推进。 */
function eligible(row: FileRow, kind: CleanupKind, now: Date): boolean {
  if (kind === 'expire') {
    const expiry = expiryOf(row);
    return (row.status === 'registered' || row.status === 'uploaded') && !!expiry && expiry < now;
  }
  // cleanup_at 为空 = 恢复校验隔离件（等人工核对），不是“允许回收”；正常回收一定写了 cleanup_at
  const graceEnd = row.cleanupAt && new Date(row.cleanupAt.getTime() + ATTACHMENT_PURGE_GRACE_HOURS * HOUR);
  return row.status === 'pending_cleanup' && row.sealedAt === null && !!graceEnd && graceEnd < now;
}

/** 候选按“本 kind 已失败次数少的优先”，不让反复失败的条目霸占每轮名额。 */
async function candidates(tx: Tx, tenantId: string, kind: CleanupKind, now: Date, limit: number) {
  const stamp = now.toISOString();
  const rows =
    kind === 'expire'
      ? await tx.execute(sql`SELECT f.id FROM attachment_files f
          LEFT JOIN attachment_cleanup_attempts a ON a.tenant_id=f.tenant_id AND a.file_id=f.id AND a.kind='expire'
          WHERE f.tenant_id=${tenantId} AND f.status IN ('registered','uploaded')
            AND coalesce(f.expires_at, ${registeredExpiry(sql.raw('f'))}) < ${stamp}::timestamptz
          ORDER BY coalesce(a.attempts,0), coalesce(f.expires_at, f.created_at), f.id LIMIT ${limit}`)
      : await tx.execute(sql`SELECT f.id FROM attachment_files f
          LEFT JOIN attachment_cleanup_attempts a ON a.tenant_id=f.tenant_id AND a.file_id=f.id AND a.kind='purge'
          WHERE f.tenant_id=${tenantId} AND f.status='pending_cleanup' AND f.sealed_at IS NULL
            AND f.cleanup_at IS NOT NULL
            AND f.cleanup_at + make_interval(hours => ${ATTACHMENT_PURGE_GRACE_HOURS}) < ${stamp}::timestamptz
          ORDER BY coalesce(a.attempts,0), f.cleanup_at, f.id LIMIT ${limit}`);
  return rowsOf<{ id: string }>(rows).map((row) => row.id);
}

async function saveAttempt(
  tx: Tx,
  tenant: Tenant,
  fileId: string,
  kind: CleanupKind,
  now: Date,
  state: 'succeeded' | 'failed',
  reason: string | null,
) {
  await tx
    .insert(A)
    .values({
      tenantId: tenant.id,
      fileId,
      kind,
      period: tenantLocalDate(now, tenant.timezone),
      status: state,
      attempts: 1,
      reason,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [A.tenantId, A.fileId, A.kind],
      set: {
        period: tenantLocalDate(now, tenant.timezone),
        status: state,
        reason,
        updatedAt: now,
        attempts: sql`${A.attempts}+1`,
      },
    });
}

/** 一个文件的一次推进：成功返回 true，状态已不满足条件（被别人推进 / 正被锁定）返回 false。 */
async function advance(
  tx: Tx,
  tenant: Tenant,
  fileId: string,
  kind: CleanupKind,
  now: Date,
  store: AttachmentBlobStore,
) {
  const [before] = await tx
    .select()
    .from(F)
    .where(and(eq(F.tenantId, tenant.id), eq(F.id, fileId)))
    .for('update', { skipLocked: true });
  if (!before || !eligible(before, kind, now)) return false;
  const patch = kind === 'expire' ? { status: 'pending_cleanup', cleanupAt: now } : { status: 'purged', purgedAt: now };
  if (kind === 'purge')
    await store.remove(tx, tenant.id, fileId).catch(() => Promise.reject(new CleanupStepFailure('blob_delete_failed')));
  const [after] = await tx
    .update(F)
    .set({ ...patch, revision: before.revision + 1, updatedAt: now })
    .where(and(eq(F.tenantId, tenant.id), eq(F.id, fileId)))
    .returning();
  // 系统身份写审计（actor 记空），与状态变更同事务；命令 ID 按“对象 + 动作”固定
  await record(
    tx,
    { tenantId: tenant.id, userId: SYSTEM_USER_ID, now, commandId: `att-cleanup:${kind}:${fileId}` },
    kind === 'expire' ? 'expired' : 'purged',
    before,
    after!,
  );
  await saveAttempt(tx, tenant, fileId, kind, now, 'succeeded', null);
  return true;
}

/**
 * 失败原因只存白名单错误码 + 固定摘要，绝不持久化 error.message / 栈（R1 P2-2）：数据库驱动错误的正文是整条 SQL 加参数，
 * 存储层异常可能带着文件内容片段，它们都不能进 attachment_cleanup_attempts、结果回报和调度器日志。
 */
const FAILURE_SUMMARY = {
  blob_delete_failed: '删除字节失败',
  db_error: '数据库操作失败',
  app_error: '业务校验未通过',
  unknown: '未归类的异常',
} as const;
type FailureCode = keyof typeof FAILURE_SUMMARY;

/** 只携带错误码的内部异常：包住底层异常但不保留其 message / cause。 */
class CleanupStepFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(FAILURE_SUMMARY[code]);
    this.name = 'CleanupStepFailure';
  }
}

/** 驱动层错误的形态：Drizzle 的 DrizzleQueryError（query + params）或 postgres 的 PostgresError（5 位 SQLSTATE）。 */
function isDatabaseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const shape = error as { query?: unknown; params?: unknown; code?: unknown; severity?: unknown; cause?: unknown };
  if (typeof shape.query === 'string' && Array.isArray(shape.params)) return true;
  if (typeof shape.severity === 'string' && typeof shape.code === 'string') return true;
  return shape.cause !== undefined && shape.cause !== error && isDatabaseError(shape.cause);
}

function failureCodeOf(error: unknown): FailureCode {
  if (error instanceof CleanupStepFailure) return error.code;
  if (error instanceof AppError) return 'app_error';
  return isDatabaseError(error) ? 'db_error' : 'unknown';
}

/** 对外（失败记录、回报、日志）统一的失败原因：白名单码 + 固定摘要。 */
export const cleanupFailureReason = (error: unknown) => {
  const code = failureCodeOf(error);
  return `${code}: ${FAILURE_SUMMARY[code]}`;
};

/** 失败回滚后另开事务记 failed：先回查，若其实已被推进（提交结果未知）就不记失败。记录本身写不进去则继续抛出，不伪造。 */
async function recordFailure(db: Db, tenant: Tenant, fileId: string, kind: CleanupKind, now: Date, error: unknown) {
  return withTenant(db, tenant.id, async (tx) => {
    const [current] = await tx
      .select({ status: F.status })
      .from(F)
      .where(and(eq(F.tenantId, tenant.id), eq(F.id, fileId)));
    const moved =
      kind === 'expire'
        ? current?.status !== 'registered' && current?.status !== 'uploaded'
        : current?.status === 'purged';
    if (!current || moved) return false;
    await saveAttempt(tx, tenant, fileId, kind, now, 'failed', cleanupFailureReason(error));
    return true;
  });
}

async function processFile(
  db: Db,
  tenant: Tenant,
  fileId: string,
  kind: CleanupKind,
  now: Date,
  store: AttachmentBlobStore,
) {
  try {
    const done = await withTenant(db, tenant.id, (tx) => advance(tx, tenant, fileId, kind, now, store));
    return done ? ({ fileId, kind, state: 'succeeded' } as const) : null;
  } catch (error) {
    const recorded = await recordFailure(db, tenant, fileId, kind, now, error);
    return recorded ? ({ fileId, kind, state: 'failed', error: cleanupFailureReason(error) } as const) : null;
  }
}

async function cleanTenant(db: Db, tenant: Tenant, now: Date, store: AttachmentBlobStore, limit: number) {
  const outcomes: CleanupOutcome[] = [];
  let remaining = limit;
  // 先过期再清理：同一轮里刚转待清理的文件 cleanup_at = 现在，一定还在宽限期内
  for (const kind of ['expire', 'purge'] as const) {
    if (remaining <= 0) break;
    const ids = await withTenant(db, tenant.id, (tx) => candidates(tx, tenant.id, kind, now, remaining));
    for (const id of ids) {
      const outcome = await processFile(db, tenant, id, kind, now, store);
      if (outcome) outcomes.push(outcome);
    }
    remaining -= ids.length;
  }
  return outcomes;
}

/** 测试入口与调度器共用：注入时钟直接调用，不依赖真实定时器（设计 §2.5）。 */
export async function runAttachmentCleanup(input: CleanupInput): Promise<{ runs: readonly CleanupRun[] }> {
  const limit = input.limit ?? ATTACHMENT_CLEANUP_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ATTACHMENT_CLEANUP_LIMIT)
    throw new AppError('VALIDATION_FAILED', `单次处理量须为 1～${ATTACHMENT_CLEANUP_LIMIT}`);
  const now = input.clock();
  const runs: CleanupRun[] = [];
  // 平台路径只列租户（启用中）；文件处理一律进对应租户的 withTenant（设计 §4.3）
  for await (const tenant of activeTenants(input.db, input.tenantId ?? null))
    runs.push({
      tenantId: tenant.id,
      outcomes: await cleanTenant(input.db, tenant, now, input.store ?? PgBlobStore, limit),
    });
  return { runs };
}
