/**
 * 写命令执行器：一个租户事务内完成“业务写 + 审计 + 命令台账”（AGENTS.md §10「幂等」「审计」）。
 * - 每个写命令都必须带客户端命令 ID（Idempotency-Key），缺失即 400 IDEMPOTENCY_KEY_REQUIRED，不存在绕过台账的写路径；
 * - 同键同内容 → 返回首次结果，不再执行；同键异内容 → 409 IDEMPOTENCY_CONFLICT；
 * - 执行失败时先回查台账（结果未知先回查，DEC-067）：并发的同键同内容请求中，败者可能因行锁后 revision 已变
 *   得到 409，或在主键上冲突，只要先提交者已记录同一命令，就重放其响应而不是报错。
 * 失败的命令整体回滚、不入台账，客户端可按原键重提；失败本身按“业务失败 / 存储不可写 / 结果未知”三类另记审计
 * （R1-T16，audit/failures.ts），结果未知时返回 503 RESULT_UNKNOWN，提示按原命令 ID 回查。
 */
import { createHash } from 'node:crypto';
import { commandLedger, type Db, eq, type Tx, withTenant } from '@italent/db';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { classifyCommandFailure, type CommandPhase, failureResponse, recordCommandFailure } from './audit/failures.js';
import { AppError } from './errors.js';
import type { TenantContext } from './tenant-context.js';

export interface CommandResult {
  readonly status: ContentfulStatusCode;
  readonly body: unknown;
}

export interface Command {
  /** 客户端命令 ID（Idempotency-Key 请求头）；必填。 */
  readonly id: string | undefined;
  /** 决定“同内容”的请求指纹（方法、路径、前置 revision、请求体等）。 */
  readonly fingerprint: unknown;
  readonly execute: (tx: Tx, commandId: string) => Promise<CommandResult>;
}

const COMMAND_ID = /^[A-Za-z0-9:_-]{1,100}$/;

export async function runCommand(db: Db, ctx: TenantContext, command: Command): Promise<CommandResult> {
  const commandId = command.id;
  if (commandId === undefined) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', '写请求必须携带 Idempotency-Key');
  if (!COMMAND_ID.test(commandId)) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key 格式不合法');
  const requestHash = commandHash(ctx.userId, command.fingerprint);

  let phase: CommandPhase = 'execute';
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      const replay = await findReplay(tx, commandId, requestHash);
      if (replay) return replay;
      const result = await command.execute(tx, commandId);
      await tx.insert(commandLedger).values({
        tenantId: ctx.tenantId,
        commandId,
        requestHash,
        responseStatus: result.status,
        responseBody: result.body,
      });
      // 回调返回后由驱动提交：此后的错误可能发生在提交请求已发出之后
      phase = 'commit';
      return result;
    });
  } catch (error) {
    let final: unknown = error;
    let recheckFailed = false;
    try {
      return await replayAfterFailure(db, ctx.tenantId, { commandId, requestHash }, error);
    } catch (thrown) {
      recheckFailed = thrown !== error && !(thrown instanceof AppError);
      if (!recheckFailed) final = thrown;
    }
    const failure = classifyCommandFailure(final, phase, recheckFailed);
    await recordCommandFailure(db, ctx, commandId, failure);
    throw failureResponse(final, failure, commandId);
  }
}

/**
 * 命令失败后回查台账：已有同键同内容的记录 → 重放；同键异内容 → 409 IDEMPOTENCY_CONFLICT；
 * 台账里没有 → 原样抛出原错误。单独导出以便对“并发败者”路径做确定性测试。
 */
export async function replayAfterFailure(
  db: Db,
  tenantId: string,
  key: { readonly commandId: string; readonly requestHash: string },
  error: unknown,
): Promise<CommandResult> {
  const replay = await withTenant(db, tenantId, (tx) => findReplay(tx, key.commandId, key.requestHash));
  if (!replay) throw error;
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
  return { status: entry.responseStatus as ContentfulStatusCode, body: entry.responseBody };
}
