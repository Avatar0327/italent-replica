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
  readonly httpStatus: number;
  readonly completedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 当前用户自己发起的命令结果摘要（F-120）；不是本人的、不存在的、结果未知的一律返回 undefined（路由层映射 404）。
 * 先查命令台账（成功），再查失败命令审计（只认确定的业务失败）：同一命令 ID 先失败后重提成功时以台账为准。
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
    .where(
      and(
        eq(commandLedger.tenantId, ctx.tenantId),
        eq(commandLedger.commandId, commandId),
        eq(commandLedger.actorUserId, ctx.userId),
      ),
    );
  if (entry) {
    const body = summaryOf(entry.responseBody);
    return {
      commandId,
      status: entry.responseStatus < 400 ? 'succeeded' : 'failed',
      commandType: entry.commandType,
      ...body,
      httpStatus: entry.responseStatus,
      completedAt: entry.createdAt.toISOString(),
    };
  }
  // 存储不可写 / 结果未知不是确定结论，不在此返回：前端保持“结果待确认”，按原命令 ID 继续回查
  const [failure] = await tx
    .select()
    .from(auditCommandFailures)
    .where(
      and(
        eq(auditCommandFailures.tenantId, ctx.tenantId),
        eq(auditCommandFailures.commandId, commandId),
        eq(auditCommandFailures.actorUserId, ctx.userId),
        eq(auditCommandFailures.outcome, 'business_failed'),
      ),
    )
    .orderBy(desc(auditCommandFailures.occurredAt))
    .limit(1);
  if (!failure) return undefined;
  return {
    commandId,
    status: 'failed',
    commandType: commandTypeOf(failure.method, failure.path),
    businessType: null,
    businessId: null,
    revision: null,
    httpStatus: ERROR_STATUS[failure.errorCode as ErrorCode] ?? 500,
    completedAt: failure.occurredAt.toISOString(),
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
