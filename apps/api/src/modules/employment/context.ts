import { auditEvents, sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { Context } from 'hono';
import { requirePermission } from '../../authorization.js';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { businessDate } from './fields.js';
import type { EmploymentContext } from './types.js';
export type { EmploymentContext } from './types.js';
export { pageQuery, revision, uuidParam } from '../job/context.js';

export async function readContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  action: string,
  expectedRevision = 0,
  resource?: string,
): Promise<EmploymentContext> {
  const tenant = tenantOf(c);
  await requirePermission(deps.authorize, { ...tenant, action, ...(resource ? { resource } : {}) });
  return { ...tenant, expectedRevision, commandId: '', now: deps.clock() };
}

export function queryDate(c: Context, ctx: EmploymentContext): string {
  return businessDate(c.req.query('asOf') ?? tenantLocalDate(ctx.now, ctx.timezone));
}

export async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError('VALIDATION_FAILED', '请求必须为合法 JSON');
  }
}

export async function runWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  input: unknown,
  execute: (tx: Tx, context: EmploymentContext) => Promise<CommandResult>,
) {
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input },
    execute: (tx, commandId) => execute(tx, { ...ctx, commandId }),
  });
  const payload = result.body as { revision?: number } | null;
  if (payload?.revision !== undefined) c.header('ETag', `"${payload.revision}"`);
  return c.json(result.body, result.status);
}

export function assertRevision(expected: number, actual: number): void {
  if (expected !== actual)
    throw new AppError('REVISION_CONFLICT', '任职数据已变更，请刷新后显式重提', { expected, actual });
}

/** DEC-019：字段快照、领域事件和业务写入由同一个租户事务提交。 */
export async function auditEmployment(
  tx: Tx,
  ctx: EmploymentContext,
  action: string,
  objectType: string,
  objectId: string,
  before: unknown,
  after: unknown,
  payloadVersionId?: string,
): Promise<void> {
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action,
    objectType,
    objectId,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  await tx.execute(sql`
    WITH ownership AS (
      SELECT employee_id, id AS business_id FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${objectId}::uuid
    ), queued AS (
      INSERT INTO employment_outbox(
        tenant_id,employee_id,business_id,event_type,object_type,object_id,command_id,payload,
        payload_version_id,created_at
      )
      SELECT ${ctx.tenantId},ownership.employee_id,ownership.business_id,${action},${objectType},${objectId},
        ${ctx.commandId},${JSON.stringify({ before, after })}::jsonb,${payloadVersionId ?? null}::uuid,
        ${ctx.now.toISOString()}::timestamptz
      FROM (SELECT 1) seed LEFT JOIN ownership ON true RETURNING id
    )
    INSERT INTO employment_outbox_attempts(tenant_id,outbox_id,attempt_no,state,created_at)
    SELECT ${ctx.tenantId},id,1,'pending',${ctx.now.toISOString()}::timestamptz FROM queued
  `);
}
