import { pgErrorCode, withTenant, type Tx } from '@italent/db';
import type { Context } from 'hono';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { authorizeTx, requirePerson, trim, type AccessContext } from './access.js';
import type { Row } from './store.js';

export async function body(c: Context) {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    throw new AppError('VALIDATION_FAILED', '请求必须为合法 JSON');
  }
}
export async function write(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: AccessContext,
  employeeId: string,
  operation: 'create' | 'update' | 'delete',
  input: Row,
  execute: (tx: Tx, ctx: AccessContext) => Promise<Row>,
  button: string = operation,
  fingerprint: unknown = input,
) {
  await withTenant(deps.db, ctx.tenantId, (tx) => requirePerson(tx, ctx, employeeId));
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input: fingerprint },
    execute: async (tx, commandId) => {
      const command = { ...ctx, commandId };
      await requirePerson(tx, command, employeeId);
      await authorizeTx(tx, deps, command, operation, input, button);
      return { status: operation === 'create' ? 201 : 200, body: await execute(tx, command) };
    },
  });
  // Replays are a read under current rights, not a cached authorization decision.
  await withTenant(deps.db, ctx.tenantId, (tx) => requirePerson(tx, ctx, employeeId));
  const value = result.body as Row;
  if (value.revision !== undefined) c.header('ETag', `"${value.revision}"`);
  return c.json(await trim(deps, ctx, ctx.objectCode, value), result.status);
}
/** Database diagnostics can contain ID/contact values: map errors before the global console.error fallback. */
export async function safe<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = pgErrorCode(error);
    if (code === '23505') throw new AppError('CONFLICT', '人员唯一性约束冲突');
    if (code === '23503' || code === '23514') throw new AppError('VALIDATION_FAILED', '人员关联或约束不合法');
    throw new AppError('SERVICE_UNAVAILABLE', '人员服务暂不可用');
  }
}
