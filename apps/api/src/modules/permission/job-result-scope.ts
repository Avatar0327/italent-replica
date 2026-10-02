/** 台账返回统一验当前对象与原始响应快照，涵盖创建/修改/导入及失败回查重放。 */
import type { Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { jobScopeReader, type ScopeBusinessContext, type ScopedJobKind } from './module-contracts.js';
import { creatorOf, hasCreatorScope, visible, type ModuleScope } from './module-route-access.js';

export async function authorizeJobResult(
  tx: Tx,
  ctx: ScopeBusinessContext,
  scope: ModuleScope,
  kind: ScopedJobKind,
  body: unknown,
): Promise<void> {
  if (scope.all || !body || typeof body !== 'object') return;
  const value = body as Record<string, unknown>;
  const records = Array.isArray(value.results) ? (value.results as Record<string, unknown>[]) : [value];
  for (const record of records) {
    const id = typeof record.id === 'string' ? record.id : record.objectId;
    if (typeof id !== 'string') continue;
    const current =
      (await jobScopeReader().load(tx, ctx.tenantId, kind, id, tenantLocalDate(ctx.now, ctx.timezone), true)) ??
      (await jobScopeReader().latest(tx, ctx.tenantId, kind, id));
    if (!current) throw new AppError('NOT_FOUND', '职务体系对象不存在或已失效');
    const creator = hasCreatorScope(scope) ? await creatorOf(tx, ctx.tenantId, id, 'job.create', kind) : undefined;
    visible(
      scope,
      kind === 'positions' ? (current.orgId ?? undefined) : undefined,
      '职务体系对象不存在或已失效',
      creator,
    );
    if (kind === 'positions' && typeof record.orgId === 'string')
      visible(scope, record.orgId, '职务体系对象不存在或已失效', creator);
  }
}
