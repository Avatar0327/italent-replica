/** F-317：逐项独立事务；批次指纹、子项台账和最终回执均复用统一命令出口。 */
import { createHash } from 'node:crypto';
import { RevisionConflictError, withTenant } from '@italent/db';
import { HANDOVER_BATCH_SUBMIT_BUTTON, HANDOVER_ROW_SUBMIT_BUTTON } from '@italent/domain';
import { isDefiniteFailure } from '../../audit/failures.js';
import { commandHash, replayAfterFailure, runCommand, type CommandGuard, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { commandContext, requireEmploymentWrite } from './context.js';
import { handoverSubmitGuard, requireHandoverSubmit, submitExitHandover } from './exit-handover-launch.js';
import { latestHandoverOfExit } from './exit-handover-store.js';
import type { EmploymentContext } from './types.js';

export interface HandoverBatchItem {
  readonly exitRequestId: string;
  readonly revision: number;
}
interface Receipt {
  readonly exitRequestId: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly requestId?: string;
  readonly revision?: number;
}
const batchButton = HANDOVER_BATCH_SUBMIT_BUTTON.code;
const failed = (exitRequestId: string, reason: string): Receipt => ({ exitRequestId, outcome: 'failed', reason });

/** 非确定错误不伪装为业务失败；整批原键重提，由已提交的子项台账恢复。 */
function failureReceipt(id: string, error: unknown): Receipt {
  if (error instanceof RevisionConflictError) return failed(id, 'REVISION_CONFLICT');
  if (!isDefiniteFailure(error)) throw error;
  const details = error.details as { reason?: string } | undefined;
  return failed(id, details?.reason ?? error.code);
}
function batchGuard(deps: TenantRouteDeps, ctx: EmploymentContext): CommandGuard {
  return {
    before: async (tx) => {
      await requireEmploymentWrite(await commandContext(tx, deps, ctx), 'update', {}, batchButton, undefined, {
        commandOnly: true,
      });
    },
  };
}
const derivedKey = (key: string, part: string) =>
  `f317:${createHash('sha256')
    .update(JSON.stringify([key, part]))
    .digest('hex')}`;

/** 首次 / 完成回放 / 中断恢复均从 commands.ts ledgerExit 验权；不在父事务里开另一连接写子事务。 */
export async function submitHandoverBatch(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  key: string | undefined,
  fingerprint: unknown,
  items: readonly HandoverBatchItem[],
): Promise<CommandResult> {
  if (key === undefined) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', '写请求必须携带 Idempotency-Key');
  if (!/^[A-Za-z0-9:_-]{1,100}$/.test(key)) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key 格式不合法');
  const guard = batchGuard(deps, ctx);
  // 先持久固定整批内容。即使进程在第一个子项后退出，换内容也必须在任何新业务写入前拒绝。
  await runCommand(deps.db, ctx, {
    id: derivedKey(key, 'manifest'),
    fingerprint,
    guard,
    execute: async () => ({ status: 200, body: { batchCommandId: key } }),
  });
  const absent = new Error('批次尚未完成');
  let completed: CommandResult | undefined;
  try {
    completed = await replayAfterFailure(
      deps.db,
      ctx.tenantId,
      { commandId: key, requestHash: commandHash(ctx.userId, fingerprint) },
      absent,
      guard,
    );
  } catch (error) {
    if (error !== absent) throw error;
  }
  if (!completed) {
    const receipts: Receipt[] = [];
    for (const item of items) {
      const context = { ...ctx, expectedRevision: item.revision };
      try {
        const result = await runCommand(deps.db, context, {
          id: derivedKey(key, item.exitRequestId),
          fingerprint: { batch: fingerprint, item },
          guard: handoverSubmitGuard(deps, context, item.exitRequestId, batchButton),
          execute: async (tx, commandId) => ({
            status: 200,
            body: await submitExitHandover(
              tx,
              { ...(await commandContext(tx, deps, context)), commandId },
              item.exitRequestId,
            ),
          }),
        });
        receipts.push(result.body as Receipt);
      } catch (error) {
        receipts.push(failureReceipt(item.exitRequestId, error));
      }
    }
    completed = await runCommand(deps.db, ctx, {
      id: key,
      fingerprint,
      guard,
      execute: async () => ({ status: 200, body: { items: receipts } }),
    });
  }
  return { status: completed.status, body: await visibleBatchReceipt(deps, ctx, completed.body) };
}

/** 不返回旧权限下缓存的 requestId / 状态 / 原因；无权项只回显用户提供的离职 ID 与拒绝原因。 */
async function visibleBatchReceipt(deps: TenantRouteDeps, ctx: EmploymentContext, body: unknown) {
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const scoped = await commandContext(tx, deps, ctx);
    const result: Receipt[] = [];
    for (const receipt of (body as { items: Receipt[] }).items) {
      try {
        await requireHandoverSubmit(tx, scoped, receipt.exitRequestId, batchButton);
        result.push(receipt);
      } catch (error) {
        result.push(failureReceipt(receipt.exitRequestId, error));
      }
    }
    return { items: result };
  });
}

/** rowActions 是披露，不影响列表准入；仅返回当前可首次发起的列表行编码。 */
export async function handoverRowActions(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  items: readonly { id: string }[],
) {
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const scoped = await commandContext(tx, deps, ctx);
    const actions = new Map<string, string[]>();
    for (const item of items) {
      const available: string[] = [];
      try {
        const business = await requireHandoverSubmit(tx, scoped, item.id, HANDOVER_ROW_SUBMIT_BUTTON.code);
        if (
          ['in_review', 'approved', 'effective'].includes(business.status) &&
          !(await latestHandoverOfExit(tx, ctx.tenantId, item.id))
        )
          available.push(HANDOVER_ROW_SUBMIT_BUTTON.code);
      } catch (error) {
        if (!(error instanceof AppError) || !['FORBIDDEN', 'NOT_FOUND'].includes(error.code)) throw error;
      }
      actions.set(item.id, available);
    }
    return actions;
  });
}
