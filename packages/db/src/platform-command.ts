/**
 * 平台写命令的统一包装（AGENTS.md §10「并发」「幂等」「审计」；docs/08_设计/R1-T00 §3）。
 * 每个平台写操作都经 runPlatformCommand，在一个事务内完成：
 *   查平台命令台账 → 执行（更新带 revision 条件）→ 写审计 → 登记台账。
 * - 同 commandId 同内容 → 重放首次结果；同 commandId 异内容 → IdempotencyConflictError；
 * - 执行失败后先回查台账（结果未知先回查，DEC-067）：并发的同键同内容请求中败者重放先提交者的结果；
 * - 审计：与租户相关的变更经 ctx.auditTenant 写入该租户的 audit_events（事务内显式切到租户路径），
 *   无租户归属的变更经 ctx.auditPlatform 写入 platform_audit_events。
 */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { auditEvents, platformAuditEvents, platformCommandLedger } from './schema/index.js';
import { APP_ROLE, isUuid, type Tx, withPlatform } from './tenant-context.js';

/** 平台写命令的元信息：操作人（平台方 / 系统任务为 null）与客户端命令 ID。 */
export interface PlatformCommandMeta {
  readonly actorUserId: string | null;
  readonly commandId: string;
}

export interface AuditEntry {
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface PlatformCommandContext {
  readonly tx: Tx;
  /** 在同一事务内临时切到租户路径（app_user + app.tenant_id），结束后切回平台角色。 */
  inTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  auditTenant(tenantId: string, entry: AuditEntry): Promise<void>;
  auditPlatform(entry: AuditEntry): Promise<void>;
}

/** revision 不一致（AGENTS.md §10「并发」）；API 层映射为 409 REVISION_CONFLICT。 */
export class RevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT';
  constructor(
    readonly object: string,
    readonly expectedRevision: number,
  ) {
    super(`${object} 的 revision 已不是 ${expectedRevision}`);
    this.name = 'RevisionConflictError';
  }
}

/** 同一命令 ID 已用于不同内容；API 层映射为 409 IDEMPOTENCY_CONFLICT。 */
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(readonly commandId: string) {
    super(`命令 ID ${commandId} 已用于不同内容的请求`);
    this.name = 'IdempotencyConflictError';
  }
}

const COMMAND_ID = /^[A-Za-z0-9:_-]{1,100}$/;

export async function runPlatformCommand<T>(
  db: Db,
  meta: PlatformCommandMeta,
  op: string,
  input: unknown,
  execute: (ctx: PlatformCommandContext) => Promise<T>,
): Promise<T> {
  if (!COMMAND_ID.test(meta.commandId)) throw new TypeError('平台命令必须携带合法的 commandId');
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ actorUserId: meta.actorUserId, op, input }))
    .digest('hex');
  try {
    return await withPlatform(db, async (tx) => {
      const replay = await findReplay<T>(tx, meta.commandId, requestHash);
      if (replay) return replay.value;
      const result = await execute(contextFor(tx, meta));
      await tx.insert(platformCommandLedger).values({ commandId: meta.commandId, requestHash, response: result });
      return result;
    });
  } catch (error) {
    const replay = await withPlatform(db, (tx) => findReplay<T>(tx, meta.commandId, requestHash));
    if (!replay) throw error;
    return replay.value;
  }
}

async function findReplay<T>(tx: Tx, commandId: string, requestHash: string): Promise<{ value: T } | undefined> {
  const [entry] = await tx.select().from(platformCommandLedger).where(eq(platformCommandLedger.commandId, commandId));
  if (!entry) return undefined;
  if (entry.requestHash !== requestHash) throw new IdempotencyConflictError(commandId);
  return { value: reviveEntityTimestamps(entry.response) as T };
}

function contextFor(tx: Tx, meta: PlatformCommandMeta): PlatformCommandContext {
  let current: string | null = null; // 当前所处的租户上下文；可重入，但同一时刻只允许一个租户
  const inTenant = async <R>(tenantId: string, fn: (tx: Tx) => Promise<R>): Promise<R> => {
    if (!isUuid(tenantId)) throw new TypeError('inTenant：租户 ID 必须是 UUID');
    if (current === tenantId) return fn(tx);
    if (current !== null) throw new Error('inTenant：不允许在一个租户上下文中嵌套另一个租户');
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.tenant}`));
    current = tenantId;
    const result = await fn(tx);
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.platform}`));
    await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
    current = null;
    return result;
  };
  const row = (entry: AuditEntry) => ({ ...entry, actorUserId: meta.actorUserId, commandId: meta.commandId });
  return {
    tx,
    inTenant,
    auditTenant: (tenantId, entry) =>
      inTenant(tenantId, async (t) => {
        await t.insert(auditEvents).values({ tenantId, ...row(entry) });
      }),
    auditPlatform: async (entry) => {
      await tx.insert(platformAuditEvents).values(row(entry));
    },
  };
}

/**
 * 平台命令的结果都是单个实体行（租户、用户、成员关系、系统预置）。台账以 JSON 保存，Date 变成 ISO 字符串；
 * 重放时只还原实体行顶层的已知时间戳列，不触碰其他字段——尤其是 value 等业务 JSON 里的同名或形似字段。
 */
const ENTITY_TIMESTAMP_COLUMNS = ['createdAt', 'updatedAt'] as const;

export function reviveEntityTimestamps(response: unknown): unknown {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return response;
  const entity: Record<string, unknown> = { ...response };
  for (const column of ENTITY_TIMESTAMP_COLUMNS) {
    const v = entity[column];
    if (typeof v === 'string') entity[column] = new Date(v);
  }
  return entity;
}
