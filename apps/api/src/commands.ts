/**
 * 写命令执行器：一个租户事务内完成“业务写 + 审计 + 命令台账”（AGENTS.md §10「幂等」「审计」）。
 * - 每个写命令都必须带客户端命令 ID（Idempotency-Key），缺失即 400 IDEMPOTENCY_KEY_REQUIRED，不存在绕过台账的写路径；
 * - 同键同内容 → 返回首次结果，不再执行；同键异内容 → 409 IDEMPOTENCY_CONFLICT；
 * - 执行失败时先回查台账（结果未知先回查，DEC-067）：并发的同键同内容请求中，败者可能因行锁后 revision 已变
 *   得到 409，或在主键上冲突，只要先提交者已记录同一命令，就重放其响应而不是报错。
 * 业务写入整体回滚；DEC-956 只为命令台账写入阶段可证实的本人 5xx 回滚作废原键。
 * 失败本身按“业务失败 / 存储不可写 / 结果未知”三类另记审计
 * （R1-T16，audit/failures.ts），结果未知时返回 503 RESULT_UNKNOWN，提示按原命令 ID 回查。
 */
import { createHash } from 'node:crypto';
import { commandLedger, type Db, eq, IdempotencyConflictError, type Tx, withTenant } from '@italent/db';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { classifyCommandFailure, type CommandPhase, failureResponse, recordCommandFailure } from './audit/failures.js';
import { currentAuditRequest } from './audit/request-context.js';
import { commandTypeOf } from './command-type.js';
import { AppError } from './errors.js';
import { auditActor } from './system-actor.js';
import type { TenantContext } from './tenant-context.js';
import { advisoryLock, advisoryLockSharedPair, asUuid } from './advisory-lock.js';

export interface CommandResult {
  readonly status: ContentfulStatusCode;
  readonly body: unknown;
}

/**
 * 命令事务内的当前权限复核（可选，B1a 评定配置起用）。返回台账结果的路径只有一个出口 `ledgerExit`，直接重放与失败后回查
 * 都经过它；首次执行也从它进入同一个 `before`：
 * - `before`：事务内、查台账之前调用，按**当前**权限复核（对象 / 按钮 / 字段编辑权 / 数据范围）；首次执行时拒绝即整体回滚，
 *   业务写、审计、台账都不提交；
 * - `replayed`：命中台账后、返回之前调用，复核结果对象按当前范围仍可见。
 * 不传 guard 时 `ledgerExit` 就是查台账本身，行为与引入 guard 之前相同。
 */
export interface CommandGuard {
  before(tx: Tx): Promise<void>;
  replayed?(tx: Tx, result: CommandResult): Promise<void>;
}

export interface Command {
  /** 客户端命令 ID（Idempotency-Key 请求头）；必填。 */
  readonly id: string | undefined;
  /** 决定“同内容”的请求指纹（方法、路径、前置 revision、请求体等）。 */
  readonly fingerprint: unknown;
  readonly execute: (tx: Tx, commandId: string) => Promise<CommandResult>;
  /** 事务内的当前权限复核；缺省不复核（权限只在事务外检查）。 */
  readonly guard?: CommandGuard;
}

const COMMAND_ID = /^[A-Za-z0-9:_-]{1,100}$/;

/** F-537：按租户和发起人隔离，避免结果查询受他人同键写入影响。 */
export const commandExecutionKey = (tenantId: string, userId: string, commandId: string) =>
  ['command-execution:', asUuid(tenantId), ':', userId.toLowerCase(), ':', commandId] as const;

const ledgerWriteKey = (tenantId: string, commandId: string) =>
  ['command-ledger-write:', asUuid(tenantId), ':', commandId] as const;

/** DEC-956：专用台账回执只存旧键拒绝码和初次 5xx 的 HTTP 状态。 */
export function voidedCommandHttpStatus(entry: Pick<CommandResultRow, 'responseStatus' | 'responseBody'>) {
  if (entry.responseStatus !== 409) return undefined;
  const body = entry.responseBody as { code?: unknown; rollbackHttpStatus?: unknown } | null;
  return body?.code === 'COMMAND_VOIDED' && typeof body.rollbackHttpStatus === 'number'
    ? body.rollbackHttpStatus
    : undefined;
}
type CommandResultRow = typeof commandLedger.$inferSelect;

export async function runCommand(db: Db, ctx: TenantContext, command: Command): Promise<CommandResult> {
  const commandId = command.id;
  if (commandId === undefined) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', '写请求必须携带 Idempotency-Key');
  if (!COMMAND_ID.test(commandId)) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key 格式不合法');
  const requestHash = commandHash(ctx.userId, command.fingerprint);

  const key = { commandId, requestHash };
  const request = currentAuditRequest();
  if (request?.commandId && request.commandId !== commandId) request.state.usedDerivedCommand = true;
  const actorUserId = auditActor(ctx.userId);
  const commandType = commandTypeOf(request?.method, request?.path);
  let phase: CommandPhase = 'execute';
  let startedLedgerWrite = false;
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      // 台账键保护同租户同键的写入与作废；发起人键保留 F-120 失败回查的隔离。
      await advisoryLockSharedPair(
        tx,
        ledgerWriteKey(ctx.tenantId, commandId),
        commandExecutionKey(ctx.tenantId, ctx.userId, commandId),
      );
      const replay = await ledgerExit(tx, key, command.guard);
      if (replay) return replay;
      const result = await command.execute(tx, commandId);
      startedLedgerWrite = true;
      await tx.insert(commandLedger).values({
        tenantId: ctx.tenantId,
        commandId,
        requestHash,
        responseStatus: result.status,
        responseBody: result.body,
        actorUserId,
        commandType,
      });
      // 回调返回后由驱动提交：此后的错误可能发生在提交请求已发出之后
      phase = 'commit';
      return result;
    });
  } catch (error) {
    let final: unknown = error;
    let recheckFailed = false;
    try {
      // 回查同样经过 ledgerExit：撤权后，并发败者也拿不到先提交者的结果（#199 第 3 轮）
      return await replayAfterFailure(db, ctx.tenantId, key, error, command.guard);
    } catch (thrown) {
      recheckFailed =
        thrown !== error && !(thrown instanceof AppError) && !(thrown instanceof IdempotencyConflictError);
      if (!recheckFailed) final = thrown;
    }
    const failure = classifyCommandFailure(final, phase, recheckFailed);
    // 业务执行和取锁阶段失败保留同键重试。只在写入回执的阶段记录可解锁的回滚证据。
    const confirmedRollback =
      startedLedgerWrite &&
      phase === 'execute' &&
      !recheckFailed &&
      final === error &&
      failure.outcome !== 'unknown' &&
      (failure.httpStatus ?? 500) >= 500;
    const rollbackHttpStatus = failure.outcome === 'storage_unwritable' ? 503 : (failure.httpStatus ?? 500);
    // 未分类的业务异常由 HTTP 错误边界映射为 500；无作废回执时也不能把它当作可解锁的普通拒绝。
    const auditFailure =
      failure.outcome === 'business_failed' && failure.httpStatus == null
        ? { ...failure, httpStatus: rollbackHttpStatus }
        : failure;
    const voided = await recordCommandFailure(
      db,
      ctx,
      commandId,
      auditFailure,
      // 总回执事务的回滚不能证明同请求的派生子事务也回滚。
      confirmedRollback && request?.commandId === commandId && !request.state.usedDerivedCommand && actorUserId
        ? (tx, createdAt) =>
            voidCommand(tx, {
              tenantId: ctx.tenantId,
              commandId,
              requestHash,
              actorUserId,
              commandType,
              createdAt,
              responseStatus: 409,
              responseBody: { code: 'COMMAND_VOIDED', rollbackHttpStatus },
            })
        : undefined,
    );
    throw failureResponse(final, failure, commandId, voided);
  }
}

async function voidCommand(tx: Tx, entry: typeof commandLedger.$inferInsert): Promise<boolean> {
  await advisoryLock(tx, ...ledgerWriteKey(entry.tenantId, entry.commandId));
  // 持锁前可能已有并发写入完成。台账已有结论时，原结论优先且不记录可解锁证据。
  const inserted = await tx
    .insert(commandLedger)
    .values(entry)
    .onConflictDoNothing()
    .returning({ commandId: commandLedger.commandId });
  return inserted.length > 0;
}

interface LedgerKey {
  readonly commandId: string;
  readonly requestHash: string;
}

/**
 * 命令失败后回查台账：已有同键同内容的记录 → 重放；同键异内容 → 409 IDEMPOTENCY_CONFLICT；
 * 台账里没有 → 原样抛出原错误。与直接重放走同一个出口（含 guard）。单独导出以便对“并发败者”路径做确定性测试。
 */
export async function replayAfterFailure(
  db: Db,
  tenantId: string,
  key: LedgerKey,
  error: unknown,
  guard?: CommandGuard,
): Promise<CommandResult> {
  const replay = await withTenant(db, tenantId, (tx) => ledgerExit(tx, key, guard));
  if (!replay) throw error;
  return replay;
}

/**
 * 返回台账结果的唯一出口：先按当前权限复核，再查台账，命中则复核结果可见性后才交出。新增任何回查分支都必须走这里，
 * 不得直接调用 findReplay 返回结果（DEC-385③：同类问题曾两次换出口重现）。
 */
async function ledgerExit(tx: Tx, key: LedgerKey, guard?: CommandGuard): Promise<CommandResult | undefined> {
  await guard?.before(tx);
  const replay = await findReplay(tx, key.commandId, key.requestHash);
  if (replay) await guard?.replayed?.(tx, replay);
  return replay;
}

export function commandHash(userId: string, fingerprint: unknown): string {
  return createHash('sha256').update(JSON.stringify({ userId, fingerprint })).digest('hex');
}

async function findReplay(tx: Tx, commandId: string, requestHash: string): Promise<CommandResult | undefined> {
  const [entry] = await tx.select().from(commandLedger).where(eq(commandLedger.commandId, commandId));
  if (!entry) return undefined;
  if (entry.requestHash !== requestHash) {
    throw new AppError('IDEMPOTENCY_CONFLICT', '同一命令 ID 已用于不同内容的请求');
  }
  if (voidedCommandHttpStatus(entry) !== undefined) {
    throw new AppError('COMMAND_VOIDED', '原命令已作废，请核对后重新提交');
  }
  return { status: entry.responseStatus as ContentfulStatusCode, body: entry.responseBody };
}
