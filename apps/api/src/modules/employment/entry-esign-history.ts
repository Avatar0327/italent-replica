import { and, desc, eq, esignTasks, sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { requirePermission } from '../../authorization.js';
import type { TenantRouteDeps } from '../../routes.js';
import { presentRecord, RECORD_OBJECT, recordScope } from '../esign/record-access.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { EMPLOYMENT_OBJECT } from './context.js';
import { ENTRY_KINDS } from './employee-status.js';
import { missingEntrySignSource } from './entry-esign-source.js';
import { loadEmploymentRecord } from './read-model.js';
import type { EmploymentContext } from './types.js';

export async function entrySignHistory(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  id: string,
  { page, pageSize }: { page: number; pageSize: number },
) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  await requirePermission(authorize, { ...ctx, action: 'object.view', resource: EMPLOYMENT_OBJECT });
  await requirePermission(authorize, { ...ctx, action: 'object.view', resource: RECORD_OBJECT });

  // F-505 §7：只按实时任职范围定位原记录，历史审批冻结份不参与授权。
  const sourceScope = await resolveModuleScopeInTransaction(
    deps,
    ctx,
    tx,
    EMPLOYMENT_OBJECT,
    `${EMPLOYMENT_OBJECT}.detail`,
  );
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const source = await loadEmploymentRecord(tx, ctx.tenantId, id, asOf, sourceScope);
  if (!source || !ENTRY_KINDS.includes(source.kind)) throw missingEntrySignSource();
  const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, RECORD_OBJECT, `${RECORD_OBJECT}.list`);
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, RECORD_OBJECT, tx);
  const where = and(
    eq(esignTasks.tenantId, ctx.tenantId),
    eq(esignTasks.scene, 'entry'),
    eq(esignTasks.businessId, source.id),
    recordScope(scope),
  );
  const [total] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(esignTasks)
    .where(where);
  const tasks = await tx
    .select()
    .from(esignTasks)
    .where(where)
    .orderBy(desc(esignTasks.initiatedAt), desc(esignTasks.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const items = [];
  for (const task of tasks) items.push(await presentRecord(tx, ctx, task, fields));
  return { items, total: total!.count, page, pageSize };
}
