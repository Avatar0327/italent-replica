import {
  and,
  asc,
  eq,
  onboardingIntegrationTaskPool as pool,
  pgErrorCode,
  type IntegrationPoolCategory,
  type IntegrationPoolTask,
  type Tx,
} from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { requireNew } from '../job/context.js';
import {
  checkIntegrationPoolAction,
  type IntegrationPoolAction,
  type PoolCreateInput,
  type PoolPatchInput,
} from './integration-pool-input.js';

interface PoolContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly now: Date;
  readonly commandId: string;
  readonly expectedRevision: number;
}

interface PoolQuery {
  readonly category?: IntegrationPoolCategory | undefined;
  readonly enabled?: boolean | undefined;
  readonly limit: number;
  readonly offset: number;
}

export function listIntegrationPoolTasks(tx: Tx, tenantId: string, query: PoolQuery) {
  return tx
    .select()
    .from(pool)
    .where(
      and(
        eq(pool.tenantId, tenantId),
        query.category === undefined ? undefined : eq(pool.category, query.category),
        query.enabled === undefined ? undefined : eq(pool.enabled, query.enabled),
      ),
    )
    .orderBy(asc(pool.code), asc(pool.id))
    .limit(query.limit)
    .offset(query.offset);
}

async function getPoolTask(tx: Tx, tenantId: string, id: string, lock?: 'share' | 'update') {
  const query = tx
    .select()
    .from(pool)
    .where(and(eq(pool.tenantId, tenantId), eq(pool.id, id)));
  const [row] = await (lock ? query.for(lock) : query);
  if (!row) throw new AppError('NOT_FOUND', '融入任务定义不存在');
  return row;
}

export function readIntegrationPoolTask(tx: Tx, tenantId: string, id: string) {
  return getPoolTask(tx, tenantId, id);
}

function storedAction(row: IntegrationPoolTask) {
  return row.category === 'probation_assessment'
    ? { type: 'assessment', assessmentType: row.assessmentType, name: row.assessmentName }
    : { type: 'form', fields: row.formFields };
}

/** 16b-1 持共享锁校验当前定义，并在同一事务写入同租户组合外键。 */
export async function lockIntegrationPoolTaskForAttachment(tx: Tx, tenantId: string, id: string) {
  const task = await getPoolTask(tx, tenantId, id, 'share');
  const action = checkIntegrationPoolAction(task.category, storedAction(task));
  if (!task.enabled) {
    throw new AppError('VALIDATION_FAILED', '融入任务定义已停用', { reason: 'INTEGRATION_TASK_DISABLED' });
  }
  return poolTaskView(task, action);
}

function actionColumns(action: IntegrationPoolAction) {
  return action.type === 'assessment'
    ? { assessmentType: action.assessmentType, assessmentName: action.name, formFields: null }
    : { assessmentType: null, assessmentName: null, formFields: action.fields };
}

export function poolTaskView(row: IntegrationPoolTask, action = storedAction(row)) {
  const { id, code, name, description, category, enabled, revision } = row;
  return { id, code, name, description, category, enabled, action, revision };
}

function receipt(row: IntegrationPoolTask, deleted = false) {
  const { id, revision, enabled } = row;
  if (deleted) return { id, revision, status: 'deleted' };
  return { id, revision, status: enabled ? 'enabled' : 'disabled' };
}

async function auditPoolTask(
  tx: Tx,
  ctx: PoolContext,
  action: 'create' | 'update' | 'delete',
  before: IntegrationPoolTask | null,
  after: IntegrationPoolTask | null,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: `onboarding.integration_pool.${action}`,
    objectType: 'onboarding-integration-task-pool',
    objectId: (after ?? before)!.id,
    before: before && { integrationTaskPool: poolTaskView(before) },
    after: after && { integrationTaskPool: poolTaskView(after) },
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

async function lockAtRevision(tx: Tx, ctx: PoolContext, id: string) {
  const row = await getPoolTask(tx, ctx.tenantId, id, 'update');
  if (ctx.expectedRevision !== row.revision)
    throw new AppError('REVISION_CONFLICT', '融入任务定义已变更，请刷新后重提');
  return row;
}

export async function createIntegrationPoolTask(tx: Tx, ctx: PoolContext, input: PoolCreateInput) {
  requireNew(ctx);
  const action = checkIntegrationPoolAction(input.category, input.action);
  const [row] = await tx
    .insert(pool)
    .values({
      tenantId: ctx.tenantId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      category: input.category,
      enabled: input.enabled ?? true,
      ...actionColumns(action),
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing({ target: [pool.tenantId, pool.code] })
    .returning();
  if (!row) throw new AppError('CONFLICT', '融入任务编码已存在', { reason: 'INTEGRATION_TASK_CODE_TAKEN' });
  await auditPoolTask(tx, ctx, 'create', null, row);
  return receipt(row);
}

export async function updateIntegrationPoolTask(tx: Tx, ctx: PoolContext, id: string, input: PoolPatchInput) {
  const before = await lockAtRevision(tx, ctx, id);
  const category = input.category ?? before.category;
  const action = checkIntegrationPoolAction(category, input.action === undefined ? storedAction(before) : input.action);
  const [row] = await tx
    .update(pool)
    .set({
      name: input.name,
      description: input.description,
      category,
      enabled: input.enabled,
      ...actionColumns(action),
      revision: before.revision + 1,
      updatedBy: ctx.userId,
      updatedAt: ctx.now,
    })
    .where(and(eq(pool.tenantId, ctx.tenantId), eq(pool.id, id)))
    .returning();
  await auditPoolTask(tx, ctx, 'update', before, row!);
  return receipt(row!);
}

export async function deleteIntegrationPoolTask(tx: Tx, ctx: PoolContext, id: string) {
  const before = await lockAtRevision(tx, ctx, id);
  try {
    // 后续方案、历史任务的引用由组合外键强制；应用层预查不能防止并发新挂接。
    await tx.delete(pool).where(and(eq(pool.tenantId, ctx.tenantId), eq(pool.id, id)));
  } catch (error) {
    const code = pgErrorCode(error);
    // RESTRICT 在 PostgreSQL 16 与 PGlite 分别使用 23503、23001。
    if (code !== '23503' && code !== '23001') throw error;
    throw new AppError('CONFLICT', '融入任务已被方案或历史任务引用，不能删除', {
      reason: 'INTEGRATION_TASK_REFERENCED',
    });
  }
  await auditPoolTask(tx, ctx, 'delete', before, null);
  return receipt(before, true);
}
