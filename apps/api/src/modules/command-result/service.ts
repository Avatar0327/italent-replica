import { auditCommandFailures, and, commandLedger, eq, sql, type Tx } from '@italent/db';
import { tryAdvisoryLock } from '../../advisory-lock.js';
import { commandTypeOf } from '../../command-type.js';
import { commandExecutionKey, voidedCommandHttpStatus } from '../../commands.js';
import { AppError, ERROR_STATUS, type ErrorCode } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { ESIGN_COMMAND_RESULTS } from '../esign/source-command-result.js';
import { INTEGRATION_POOL_COMMAND_RESULTS } from '../onboarding/integration-pool-result.js';
import { INTEGRATION_SCHEME_COMMAND_RESULTS } from '../onboarding/integration-schemes-result.js';
import { createCommandResultRegistry, type CommandResultDeps, type CommandResultRegistration } from './registry.js';

const commandResultRegistry = createCommandResultRegistry([
  ...ESIGN_COMMAND_RESULTS,
  ...INTEGRATION_POOL_COMMAND_RESULTS,
  ...INTEGRATION_SCHEME_COMMAND_RESULTS,
]);
type RegisteredResult = ReturnType<CommandResultRegistration['project']>;

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
 * 2. DEC-956：只有已作废的本人台账行可给出未执行结论；审计证明回滚本身不能阻止旧键后续写入。
 * 3. 台账没有且本人同键写入不在途，才看本人最新时间整组失败审计；其中任一条不确定则维持未知。
 * 摘要只取台账响应里的 id / revision / kind；登记类型（F-553）的成功回执则以同一事务授权后得到的投影为准。整个查询只读。
 */
export async function readOwnCommandResult(
  tx: Tx,
  ctx: TenantContext,
  commandId: string,
  deps?: CommandResultDeps,
): Promise<OwnCommandResult | RegisteredResult | undefined> {
  // 先取锁再读台账，避免并发提交刚落库、回查却选中旧的回滚证据。拿不到锁仍可返回已有的权威台账。
  const idle = await tryAdvisoryLock(tx, ...commandExecutionKey(ctx.tenantId, ctx.userId, commandId));
  const [entry] = await tx
    .select()
    .from(commandLedger)
    .where(and(eq(commandLedger.tenantId, ctx.tenantId), eq(commandLedger.commandId, commandId)));
  if (entry) {
    if (entry.actorUserId !== ctx.userId) return undefined;
    const rollbackHttpStatus = voidedCommandHttpStatus(entry);
    // 已作废的台账行没有成功回执可供登记类型核对来源，只给未执行摘要；其余登记类型按 F-553 授权投影。
    const registration = entry.commandType ? commandResultRegistry.get(entry.commandType) : undefined;
    if (registration && rollbackHttpStatus === undefined) {
      if (!deps || entry.responseStatus < 200 || entry.responseStatus >= 300) return undefined;
      return readRegisteredCommandResult(tx, deps, ctx, registration, entry.responseBody);
    }
    return {
      commandId,
      status: rollbackHttpStatus === undefined ? ledgerStatus(entry.responseStatus) : 'not_executed',
      commandType: entry.commandType,
      ...summaryOf(entry.responseBody),
      httpStatus: rollbackHttpStatus ?? entry.responseStatus,
      completedAt: entry.createdAt.toISOString(),
    };
  }
  if (!idle) return undefined;
  const latest = await latestFailureGroup(tx, ctx, commandId);
  if (!latest?.occurredAt || latest.hasUncertain) return undefined;
  const commandType = commandTypeOf(latest.method, latest.path);
  // 没有成功回执就无法核对登记类型的来源与任务绑定。
  if (commandType && commandResultRegistry.has(commandType)) return undefined;
  return {
    commandId,
    status: 'failed',
    commandType,
    businessType: null,
    businessId: null,
    revision: null,
    httpStatus: latest.httpStatus ?? ERROR_STATUS[latest.errorCode as ErrorCode] ?? null,
    completedAt: latest.occurredAt.toISOString(),
  };
}

async function readRegisteredCommandResult(
  tx: Tx,
  deps: CommandResultDeps,
  ctx: TenantContext,
  registration: CommandResultRegistration,
  body: unknown,
): Promise<RegisteredResult | undefined> {
  try {
    await registration.authorize(tx, deps, ctx, body);
    return registration.project(body);
  } catch (error) {
    // 来源缺失、越界与任务错绑走路由统一的 404 信封。
    if (error instanceof AppError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}

/**
 * 本人该命令 ID 的失败审计读取的唯一入口：一次聚合判定最新时间整组。
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
  const [group] = await tx
    .select({
      occurredAt: sql<Date | null>`max(${f.occurredAt})`.mapWith(f.occurredAt),
      hasUncertain: sql<boolean | null>`bool_or(
        ${f.outcome} <> 'business_failed' OR ${f.confirmedRollback} IS TRUE
        OR coalesce(${f.httpStatus}, 0) >= 500 OR ${f.errorCode} = 'INTERNAL_ERROR'
      )`,
      method: sql<string | null>`(array_agg(${f.method} ORDER BY ${f.id}))[1]`,
      path: sql<string | null>`(array_agg(${f.path} ORDER BY ${f.id}))[1]`,
      errorCode: sql<string>`(array_agg(${f.errorCode} ORDER BY ${f.id}))[1]`,
      httpStatus: sql<number | null>`(array_agg(${f.httpStatus} ORDER BY ${f.id}))[1]`,
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

const ledgerStatus = (httpStatus: number) => (httpStatus < 400 ? 'succeeded' : 'failed');

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
