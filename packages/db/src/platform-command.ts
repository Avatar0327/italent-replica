/**
 * 平台写命令的统一包装（AGENTS.md §10「并发」「幂等」「审计」；docs/08_设计/R1-T00 §3）。
 * 每个平台写操作都经 runPlatformCommand，在一个事务内完成：
 *   查平台命令台账 → 执行（更新带 revision 条件）→ 写审计 → 登记台账。
 * - 同 commandId 同内容 → 重放首次结果；同 commandId 异内容 → IdempotencyConflictError；
 * - 执行失败后先回查台账（结果未知先回查，DEC-067）：并发的同键同内容请求中败者重放先提交者的结果；
 * - 审计：每个平台命令都写 platform_audit_events（R1-T17）。与租户相关的变更经 ctx.auditTenant 同时写入该租户的
 *   audit_events（事务内显式切到租户路径，租户管理员可见）与平台审计（标出所涉租户）；无租户归属的变更经
 *   ctx.auditPlatform 只写平台审计。
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
  /** 写该租户的审计，并在平台审计留一份（subject_tenant_id = 该租户）。 */
  auditTenant(tenantId: string, entry: AuditEntry): Promise<void>;
  /** 只写平台审计；subjectTenantId 标出所涉租户（如开通、备份恢复），无租户归属时省略。 */
  auditPlatform(entry: AuditEntry, subjectTenantId?: string): Promise<void>;
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
  const requestHash = platformRequestHash(meta, op, input);
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

function platformRequestHash(meta: PlatformCommandMeta, op: string, input: unknown): string {
  if (!COMMAND_ID.test(meta.commandId)) throw new TypeError('平台命令必须携带合法的 commandId');
  return createHash('sha256')
    .update(JSON.stringify({ actorUserId: meta.actorUserId, op, input }))
    .digest('hex');
}

/**
 * 长任务（如定时生效的运维补跑，R1-T08）不能把整段工作包进一个平台事务：开工前先回查台账，同键同内容返回首次结果，
 * 同键异内容抛 IdempotencyConflictError，未执行过返回 undefined；做完后仍经 runPlatformCommand 登记结果
 * （并发同键时以先登记者为准）。
 */
export async function findPlatformCommandResult<T>(
  db: Db,
  meta: PlatformCommandMeta,
  op: string,
  input: unknown,
): Promise<{ value: T } | undefined> {
  const requestHash = platformRequestHash(meta, op, input);
  return withPlatform(db, (tx) => findReplay<T>(tx, meta.commandId, requestHash));
}

async function findReplay<T>(tx: Tx, commandId: string, requestHash: string): Promise<{ value: T } | undefined> {
  const [entry] = await tx.select().from(platformCommandLedger).where(eq(platformCommandLedger.commandId, commandId));
  if (!entry) return undefined;
  if (entry.requestHash !== requestHash) throw new IdempotencyConflictError(commandId);
  return { value: reviveEntityTimestamps(entry.response) as T };
}

function contextFor(tx: Tx, meta: PlatformCommandMeta): PlatformCommandContext {
  let current: string | null = null; // 当前所处的租户上下文；可重入，但同一时刻只允许一个租户
  // 租户上下文内写的租户审计，其平台审计副本要在切回平台角色后写（app_user 无权写平台审计）
  const deferred: { entry: AuditEntry; tenantId: string }[] = [];
  const inTenant = async <R>(tenantId: string, fn: (tx: Tx) => Promise<R>): Promise<R> => {
    if (!isUuid(tenantId)) throw new TypeError('inTenant：租户 ID 必须是 UUID');
    if (current === tenantId) return fn(tx);
    if (current !== null) throw new Error('inTenant：不允许在一个租户上下文中嵌套另一个租户');
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.tenant}`));
    current = tenantId;
    const result = await fn(tx);
    // 延迟约束触发器（任职时间线完整性等，均 INITIALLY DEFERRED）默认到提交时才执行，那时已切回平台角色、
    // 读不了租户表（权限不足）。离开租户上下文前就地执行完毕，再恢复为延迟（与各约束的初始模式一致）。
    // 例：停用异常管理员时接管合并会签席位、重新结算后批准业务（PR #60 第三轮在真 PostgreSQL 上发现）。
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.platform}`));
    await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
    current = null;
    for (const pending of deferred.splice(0)) await auditPlatform(pending.entry, pending.tenantId);
    return result;
  };
  const row = (entry: AuditEntry) => ({ ...entry, actorUserId: meta.actorUserId, commandId: meta.commandId });
  const auditPlatform = async (entry: AuditEntry, subjectTenantId?: string) => {
    if (current !== null) throw new Error('auditPlatform：须在平台路径上调用，不能在租户上下文内');
    await tx.insert(platformAuditEvents).values({ ...row(entry), subjectTenantId: subjectTenantId ?? null });
  };
  return {
    tx,
    inTenant,
    auditTenant: async (tenantId, entry) => {
      await inTenant(tenantId, async (t) => {
        await t.insert(auditEvents).values({ tenantId, ...row(entry) });
      });
      // 在租户上下文内调用时（可重入）推迟到切回平台路径后再写，见 flushPlatform
      if (current === null) await auditPlatform(entry, tenantId);
      else deferred.push({ entry, tenantId });
    },
    auditPlatform,
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
