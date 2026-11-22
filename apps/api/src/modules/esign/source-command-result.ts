/** F-505 §5、DEC-968：回查原来源，不随改期迁移到另一个业务 ID。 */
import { and, eq, esignOfferSources, isUuid, offers, sql, type Tx } from '@italent/db';
import { OFFER_OBJECT } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import type { CommandResultDeps, CommandResultRegistration } from '../command-result/registry.js';
import { EMPLOYMENT_OBJECT, requireEmploymentWrite } from '../employment/context.js';
import { ENTRY_KINDS } from '../employment/employee-status.js';
import { requireBusinessWriteScope } from '../employment/replay-guard.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction, scopeAllows } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { isActiveAccount } from '../approval/resolver.js';
import { authorizeSourceSignTask } from './source-result-access.js';

export const OFFER_SIGN_COMMAND = 'POST /api/tenant/offers/:id/esign-tasks';
export const ENTRY_SIGN_COMMAND = 'POST /api/tenant/employment/pending-entries/:id/esign-tasks';

function projectSourceSignReceipt(body: unknown) {
  const { sourceId, taskId } = (body ?? {}) as Partial<Record<'sourceId' | 'taskId', unknown>>;
  if (typeof sourceId !== 'string' || !isUuid(sourceId) || typeof taskId !== 'string' || !isUuid(taskId))
    throw new AppError('NOT_FOUND', '签署回执不存在');
  return { sourceId, taskId };
}

/** S4 可在发起事务复用；对应 §9 的 Offer 编辑开关，无独立按钮。 */
export async function requireOfferSignSource(tx: Tx, deps: CommandResultDeps, ctx: TenantContext, sourceId: string) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  await requireObjectWrite(authorize, ctx, { objectCode: OFFER_OBJECT, operation: 'update', payload: {} });
  const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, OFFER_OBJECT);
  const [source] = await tx
    .select({ departmentId: offers.departmentId, createdBy: offers.createdBy })
    .from(offers)
    .leftJoin(
      esignOfferSources,
      and(eq(esignOfferSources.tenantId, offers.tenantId), eq(esignOfferSources.offerId, offers.id)),
    )
    .where(
      and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, sourceId), sql`${esignOfferSources.deletedAt} IS NULL`),
    );
  if (!source || !scopeAllows(scope, { orgId: source.departmentId, creatorId: source.createdBy }))
    throw new AppError('NOT_FOUND', 'Offer 不存在');
}

/** S5 可在发起事务复用；采用现有入职动作的命令式编辑权和任职写范围。 */
export async function requireEntrySignSource(tx: Tx, deps: CommandResultDeps, ctx: TenantContext, sourceId: string) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  const context = { ...ctx, authorize, now: deps.clock(), expectedRevision: 0, commandId: '' };
  await requireEmploymentWrite(context, 'update', {}, 'Employment.Edit', undefined, { commandOnly: true });
  const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, EMPLOYMENT_OBJECT);
  const trustedScopeBypass = await authorize({ ...ctx, action: 'data.scope.all' });
  const source = await requireBusinessWriteScope(tx, authorize, { ...context, scope, trustedScopeBypass }, sourceId);
  if (source.status === 'deleted' || !ENTRY_KINDS.includes(source.kind))
    throw new AppError('NOT_FOUND', '入职记录不存在');
}

const SOURCES = [
  { scene: 'offer', commandType: OFFER_SIGN_COMMAND, requireSource: requireOfferSignSource },
  { scene: 'entry', commandType: ENTRY_SIGN_COMMAND, requireSource: requireEntrySignSource },
] as const;

export const ESIGN_COMMAND_RESULTS: readonly CommandResultRegistration[] = SOURCES.map(
  ({ scene, commandType, requireSource }) => ({
    commandType,
    project: projectSourceSignReceipt,
    authorize: async (tx, deps, ctx, body) => {
      if (!(await isActiveAccount(tx, ctx.tenantId, ctx.userId))) throw new AppError('FORBIDDEN', '发起人账号不可用');
      const { sourceId, taskId } = projectSourceSignReceipt(body);
      await requireSource(tx, deps, ctx, sourceId);
      const taskContext = { ...ctx, now: deps.clock(), expectedRevision: 0, commandId: '' };
      await authorizeSourceSignTask(tx, deps, taskContext, scene, sourceId, taskId);
    },
  }),
);
