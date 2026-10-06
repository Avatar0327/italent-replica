/**
 * 写命令失败的入口兜底（PR #75 第二轮 P2-7）：执行器（runCommand）之前就被拒绝的写命令——请求校验、授权、
 * 业务前置检查——同样记失败命令审计。挂在租户上下文中间件之后：身份、成员关系与租户已确认可信才记录，
 * 未登录 / 非成员的请求不进租户审计。只认携带合法命令 ID（Idempotency-Key）的写请求；执行器已记过的不再重复。
 * 这些失败都发生在任何写入之前，判为执行阶段（确定未生效）。
 */
import { type Db, platformFailureOf } from '@italent/db';
import type { MiddlewareHandler } from 'hono';
import { type TenantEnv, tenantOf } from '../tenant-context.js';
import { classifyCommandFailure, recordCommandFailure } from './failures.js';
import { currentAuditRequest } from './request-context.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const COMMAND_ID = /^[A-Za-z0-9:_-]{1,100}$/;

export function captureCommandFailures(db: Db): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    await next();
    const error = c.error;
    const commandId = c.req.header('idempotency-key');
    if (!error || !WRITE_METHODS.has(c.req.method) || !commandId || !COMMAND_ID.test(commandId)) return;
    if (currentAuditRequest()?.state.failureRecorded) return;
    // 租户路径上经平台命令执行的写入（如成员授予 / 撤销）：沿用平台执行器的分类（含提交阶段的结果未知），
    // 租户审计与平台受限通道各记一条、口径一致（第四轮：平台入口同类路径）
    const failure = platformFailureOf(error) ?? classifyCommandFailure(error, 'execute');
    await recordCommandFailure(db, tenantOf(c), commandId, failure);
  };
}
