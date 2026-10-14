import { auditCommandFailures, and, commandLedger, eq, sql, type Tx } from '@italent/db';
import { commandTypeOf } from '../../command-type.js';
import { ERROR_STATUS, type ErrorCode } from '../../errors.js';

export interface OwnCommandResult {
  readonly commandId: string;
  readonly status: 'succeeded' | 'failed';
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
 * 2. 台账没有，才看本人的失败命令审计（latestFailureGroup）：对**最新时间的整组**记录判类别，组内含非确定业务失败
 *    （存储不可写 / 结果未知）即视为结果未知；同一时刻有多条时，只要含未知类就按未知处理（时间戳无法区分先后，取保守）；
 * 3. 本人台账成功结果始终优先于失败审计（同一命令 ID 先失败后原键重提成功）。
 * 摘要只取台账响应里的 id / revision / kind，不返回响应正文；整个查询只读。
 */
export async function readOwnCommandResult(
  tx: Tx,
  ctx: { readonly tenantId: string; readonly userId: string },
  commandId: string,
): Promise<OwnCommandResult | undefined> {
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
  const latest = await latestFailureGroup(tx, ctx, commandId);
  if (!latest?.occurredAt || latest.hasNonBusiness) return undefined;
  return {
    commandId,
    status: 'failed',
    commandType: commandTypeOf(latest.method, latest.path),
    businessType: null,
    businessId: null,
    revision: null,
    httpStatus: latest.httpStatus ?? ERROR_STATUS[latest.errorCode as ErrorCode] ?? null,
    completedAt: latest.occurredAt.toISOString(),
  };
}

/**
 * 本人该命令 ID 的失败审计读取的**唯一入口**：数据库里一次聚合，判定“最新时间整组”——组内是否含非确定业务失败的类别，
 * 并取组内按 id 排序的第一条作为摘要来源；返回恒为一行，不依赖应用层窗口（DEC-431①：不再靠 limit 截断后在内存里判断）。
 * 没有任何记录时 occurredAt 为 null。
 */
async function latestFailureGroup(
  tx: Tx,
  ctx: { readonly tenantId: string; readonly userId: string },
  commandId: string,
) {
  const f = auditCommandFailures;
  const own = and(eq(f.tenantId, ctx.tenantId), eq(f.commandId, commandId), eq(f.actorUserId, ctx.userId));
  const [group] = await tx
    .select({
      occurredAt: sql<Date | null>`max(${f.occurredAt})`.mapWith(f.occurredAt),
      hasNonBusiness: sql<boolean | null>`bool_or(${f.outcome} <> 'business_failed')`,
      method: sql<string | null>`(array_agg(${f.method} ORDER BY ${f.id}))[1]`,
      path: sql<string | null>`(array_agg(${f.path} ORDER BY ${f.id}))[1]`,
      errorCode: sql<string>`(array_agg(${f.errorCode} ORDER BY ${f.id}))[1]`,
      httpStatus: sql<number | null>`(array_agg(${f.httpStatus} ORDER BY ${f.id}))[1]`,
    })
    .from(f)
    .where(and(own, eq(f.occurredAt, sql`(SELECT max(${f.occurredAt}) FROM ${f} WHERE ${own})`)));
  return group;
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
