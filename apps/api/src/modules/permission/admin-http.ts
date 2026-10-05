/** 企业设置类接口的公共边界：按 8 类管理员能力鉴权（06 §7.1）；写命令同一租户事务内完成业务写 + 审计 + 命令台账。 */
import { createHash } from 'node:crypto';
import { requirePermission } from '../../authorization.js';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { type TenantContext, tenantOf } from '../../tenant-context.js';
import type { WriteContext } from './audit.js';

export type RouteContext = Parameters<typeof tenantOf>[0];
type CommandTx = Parameters<Parameters<typeof runCommand>[2]['execute']>[0];

export async function adminGuard(c: RouteContext, deps: TenantRouteDeps, capability: string): Promise<TenantContext> {
  const ctx = tenantOf(c);
  await requirePermission(deps.authorize, { ...ctx, action: `admin.${capability}` });
  return ctx;
}

export function adminCommand(
  c: RouteContext,
  deps: TenantRouteDeps,
  ctx: TenantContext,
  fingerprint: unknown,
  run: (tx: CommandTx, write: WriteContext) => Promise<unknown>,
  status: 200 | 201 = 200,
) {
  return runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint,
    execute: async (tx, commandId) => {
      const write: WriteContext = { tenantId: ctx.tenantId, userId: ctx.userId, now: deps.clock(), commandId };
      return { status, body: await run(tx, write) };
    },
  });
}

const COMMAND_ID = /^[A-Za-z0-9:_-]{1,100}$/;

/**
 * 租户侧调用平台命令（停用账号、撤销成员，PR #35）时的命令 ID：平台命令台账全局唯一，按“租户 + 客户端键”派生，
 * 不同租户用了同一个 Idempotency-Key 也不会互相重放或冲突；同租户同键同内容重放首次结果（AGENTS.md §10「幂等」）。
 */
export function platformCommandId(c: RouteContext, ctx: TenantContext): string {
  const key = c.req.header('idempotency-key');
  if (key === undefined) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', '写请求必须携带 Idempotency-Key');
  if (!COMMAND_ID.test(key)) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key 格式不合法');
  return `tenant-${createHash('sha256').update(`${ctx.tenantId}:${key}`).digest('hex').slice(0, 48)}`;
}
