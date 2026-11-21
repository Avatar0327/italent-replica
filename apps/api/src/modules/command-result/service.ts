import { auditCommandFailures, and, commandLedger, eq, sql, type Tx } from '@italent/db';
import { tryAdvisoryLock } from '../../advisory-lock.js';
import { commandTypeOf } from '../../command-type.js';
import { commandExecutionKey } from '../../commands.js';
import { ERROR_STATUS, type ErrorCode } from '../../errors.js';

export interface OwnCommandResult {
  readonly commandId: string;
  readonly status: 'succeeded' | 'failed' | 'not_executed';
  readonly commandType: string | null;
  readonly businessType: string | null;
  readonly businessId: string | null;
  readonly revision: number | null;
  /** 写接口实际返回的状态；失败审计没有记录且不是公共错误码时为 null，不猜。 */
  readonly httpStatus: number | null;
  readonly completedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 当前用户自己发起的命令结果摘要（F-120）；不是本人的、不存在的、结果未知的一律返回 undefined（路由层映射 404）。
 * 1. 先按（租户，命令 ID）查台账，不带发起人条件：台账里有这个命令 ID 就已有权威归属，不是本人（含发起人为空的
 *    历史 / 系统行）直接 undefined，不得再回退到失败审计——否则别人用同一命令 ID 碰撞留下的失败审计会被当成“本人失败”；
 * 2. 台账没有且本人同键写入不在途，才看本人最新时间整组失败审计；其中任一条不确定则维持未知。
 *    F-537：执行器在独立事务留下回滚证据时可确认未执行；缺少证据的存储故障维持未知；
 * 3. 本人台账成功结果始终优先于失败审计（同一命令 ID 先失败后原键重提成功）。
 * 摘要只取台账响应里的 id / revision / kind，不返回响应正文；整个查询只读。
 */
export async function readOwnCommandResult(
  tx: Tx,
  ctx: { readonly tenantId: string; readonly userId: string },
  commandId: string,
): Promise<OwnCommandResult | undefined> {
  // 先取锁再读台账，避免并发提交刚落库、回查却选中旧的回滚证据。拿不到锁仍可返回已有的权威台账。
  const idle = await tryAdvisoryLock(tx, ...commandExecutionKey(ctx.tenantId, ctx.userId, commandId));
  const [entry] = await tx
    .select()
    .from(commandLedger)
    .where(and(eq(commandLedger.tenantId, ctx.tenantId), eq(commandLedger.commandId, commandId)));
  if (entry) {
    if (entry.actorUserId !== ctx.userId) return undefined;
    return {
      commandId,
      status: entry.responseStatus < 400 ? 'succeeded' : 'failed',
      commandType: entry.commandType,
      ...summaryOf(entry.responseBody),
      httpStatus: entry.responseStatus,
      completedAt: entry.createdAt.toISOString(),
    };
  }
  if (!idle) return undefined;
  const latest = await latestFailureGroup(tx, ctx, commandId);
  if (!latest?.occurredAt || latest.hasUncertain) return undefined;
  return {
    commandId,
    status: latest.hasRollback ? 'not_executed' : 'failed',
    commandType: commandTypeOf(latest.method, latest.path),
    businessType: null,
    businessId: null,
    revision: null,
    httpStatus: latest.httpStatus ?? failureStatus(latest),
    completedAt: latest.occurredAt.toISOString(),
  };
}

/**
 * 本人该命令 ID 的失败审计读取的唯一入口：一次聚合判定最新时间整组。若有回滚证据，优先取该条作摘要。
 * 第二次检查台账防止读取审计前他人成为权威归属；同一 SQL 快照中有台账就始终遮蔽审计。
 * 没有任何记录时 occurredAt 为 null。
 */
async function latestFailureGroup(
  tx: Tx,
  ctx: { readonly tenantId: string; readonly userId: string },
  commandId: string,
) {
  const f = auditCommandFailures;
  const own = and(eq(f.tenantId, ctx.tenantId), eq(f.commandId, commandId), eq(f.actorUserId, ctx.userId));
  const ledger = tx
    .select({ commandId: commandLedger.commandId })
    .from(commandLedger)
    .where(and(eq(commandLedger.tenantId, ctx.tenantId), eq(commandLedger.commandId, commandId)));
  const order = sql`${f.confirmedRollback} IS TRUE DESC, ${f.id}`;
  const [group] = await tx
    .select({
      occurredAt: sql<Date | null>`max(${f.occurredAt})`.mapWith(f.occurredAt),
      hasUncertain: sql<boolean | null>`bool_or(
        ${f.outcome} = 'unknown' OR (${f.outcome} = 'storage_unwritable' AND ${f.confirmedRollback} IS NOT TRUE)
      )`,
      hasRollback: sql<boolean | null>`bool_or(${f.confirmedRollback} IS TRUE)`,
      method: sql<string | null>`(array_agg(${f.method} ORDER BY ${order}))[1]`,
      path: sql<string | null>`(array_agg(${f.path} ORDER BY ${order}))[1]`,
      errorCode: sql<string>`(array_agg(${f.errorCode} ORDER BY ${order}))[1]`,
      httpStatus: sql<number | null>`(array_agg(${f.httpStatus} ORDER BY ${order}))[1]`,
      outcome: sql<string | null>`(array_agg(${f.outcome} ORDER BY ${order}))[1]`,
    })
    .from(f)
    .where(
      and(
        own,
        sql`NOT EXISTS (${ledger})`,
        eq(f.occurredAt, sql`(SELECT max(${f.occurredAt}) FROM ${f} WHERE ${own})`),
      ),
    );
  return group;
}

function failureStatus(failure: { hasRollback: boolean | null; outcome: string | null; errorCode: string }) {
  if (failure.hasRollback) return failure.outcome === 'storage_unwritable' ? 503 : 500;
  return ERROR_STATUS[failure.errorCode as ErrorCode] ?? null;
}

/** 台账响应的最小摘要：业务 ID（id，须为 UUID）、版本（revision）、业务类型（kind）；缺什么返回 null。 */
function summaryOf(body: unknown): Pick<OwnCommandResult, 'businessType' | 'businessId' | 'revision'> {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const { id, revision, kind } = record;
  return {
    businessType: typeof kind === 'string' ? kind : null,
    businessId: typeof id === 'string' && UUID.test(id) ? id : null,
    revision: typeof revision === 'number' && Number.isInteger(revision) ? revision : null,
  };
}
