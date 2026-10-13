import { auditCommandFailures, and, commandLedger, desc, eq, type Tx } from '@italent/db';
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

/** 同一命令 ID 的失败审计取最新的这几条判定；足够覆盖同一时刻的并列。 */
const LATEST_WINDOW = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 当前用户自己发起的命令结果摘要（F-120）；不是本人的、不存在的、结果未知的一律返回 undefined（路由层映射 404）。
 * 1. 先按（租户，命令 ID）查台账，不带发起人条件：台账里有这个命令 ID 就已有权威归属，不是本人（含发起人为空的
 *    历史 / 系统行）直接 undefined，不得再回退到失败审计——否则别人用同一命令 ID 碰撞留下的失败审计会被当成“本人失败”；
 * 2. 台账没有，才看本人的失败命令审计：取**最新**一条先判类别，最新一条不是确定的业务失败（存储不可写 / 结果未知）
 *    即视为结果未知；同一时刻有多条时，只要含未知类就按未知处理（时间戳无法区分先后，取保守）；
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
  const failures = await tx
    .select()
    .from(auditCommandFailures)
    .where(
      and(
        eq(auditCommandFailures.tenantId, ctx.tenantId),
        eq(auditCommandFailures.commandId, commandId),
        eq(auditCommandFailures.actorUserId, ctx.userId),
      ),
    )
    .orderBy(desc(auditCommandFailures.occurredAt))
    .limit(LATEST_WINDOW);
  const latest = failures[0];
  if (!latest) return undefined;
  const tied = failures.filter((row) => row.occurredAt.getTime() === latest.occurredAt.getTime());
  if (tied.some((row) => row.outcome !== 'business_failed')) return undefined;
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
