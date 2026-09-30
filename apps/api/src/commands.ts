/**
 * 写命令执行器：一个租户事务内完成“业务写 + 审计 + 命令台账”（AGENTS.md §10「幂等」「审计」）。
 * - 不带命令 ID：直接执行；
 * - 带命令 ID（Idempotency-Key）：同键同内容 → 返回首次结果，不再执行；同键异内容 → 409 IDEMPOTENCY_CONFLICT。
 * 失败的命令整体回滚、不入台账，客户端可按原键重提（结果未知时先回查再决定，DEC-067）。
 */
import { createHash } from 'node:crypto';
import { commandLedger, type Db, eq, pgErrorCode, type Tx, withTenant } from '@italent/db';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError } from './errors.js';
import type { TenantContext } from './tenant-context.js';

export interface CommandResult {
  readonly status: ContentfulStatusCode;
  readonly body: unknown;
}

export interface Command {
  /** 客户端命令 ID；不带时不做幂等。 */
  readonly id: string | undefined;
  /** 决定“同内容”的请求指纹（方法、路径、前置 revision、请求体等）。 */
  readonly fingerprint: unknown;
  readonly execute: (tx: Tx, commandId: string | null) => Promise<CommandResult>;
}

const COMMAND_ID = /^[A-Za-z0-9:_-]{1,100}$/;

export async function runCommand(db: Db, ctx: TenantContext, command: Command): Promise<CommandResult> {
  if (command.id === undefined) return withTenant(db, ctx.tenantId, (tx) => command.execute(tx, null));
  const commandId = command.id;
  if (!COMMAND_ID.test(commandId)) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key 格式不合法');
  const requestHash = hashOf({ userId: ctx.userId, fingerprint: command.fingerprint });

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
      return result;
    });
  } catch (error) {
    // 并发的同键请求：先提交者赢，后到者在唯一键上冲突并整体回滚，再按台账重放或报冲突
    if (pgErrorCode(error) !== '23505') throw error;
    const replay = await withTenant(db, ctx.tenantId, (tx) => findReplay(tx, commandId, requestHash));
    if (!replay) throw error;
    return replay;
  }
}

async function findReplay(tx: Tx, commandId: string, requestHash: string): Promise<CommandResult | undefined> {
  const [entry] = await tx.select().from(commandLedger).where(eq(commandLedger.commandId, commandId));
  if (!entry) return undefined;
  if (entry.requestHash !== requestHash) {
    throw new AppError('IDEMPOTENCY_CONFLICT', '同一命令 ID 已用于不同内容的请求');
  }
  return { status: entry.responseStatus as ContentfulStatusCode, body: entry.responseBody };
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
