import { withTenant } from '@italent/db';
import { AppError } from '../../errors.js';
import type { TenantRouteModule } from '../../routes.js';
import { tenantOf } from '../../tenant-context.js';
import { readOwnCommandResult } from './service.js';

/** 与 commands.ts 的 Idempotency-Key 同一格式；不合法的命令 ID 不可能存在，直接 400。 */
const COMMAND_ID = /^[A-Za-z0-9:_-]{1,100}$/;

export const registerCommandResultRoutes: TenantRouteModule = (router, deps) => {
  router.get('/api/tenant/commands/:commandId/result', async (c) => {
    const ctx = tenantOf(c);
    const commandId = c.req.param('commandId');
    if (!COMMAND_ID.test(commandId)) throw new AppError('VALIDATION_FAILED', '命令 ID 格式不合法');
    const result = await withTenant(deps.db, ctx.tenantId, (tx) => readOwnCommandResult(tx, ctx, commandId));
    // 不是本人的、不存在的、结果未知的同为 404；前端不得把 404 当作确定失败
    if (!result) throw new AppError('NOT_FOUND', '没有找到本人发起的该命令结果');
    c.header('Cache-Control', 'private, no-store');
    return c.json(result);
  });
};
