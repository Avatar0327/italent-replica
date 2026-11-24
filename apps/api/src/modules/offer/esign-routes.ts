/** F-505 §3.1、§5、§8：Offer 签署入口与来源历史。 */
import { and, desc, eq, esignTasks, sql, withTenant, type Tx } from '@italent/db';
import { MODULE_OBJECTS, OFFER_OBJECT } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { selectBusinessContent } from '../approval/handling-content.js';
import { rowsOf } from '../employment/record-store.js';
import { lockTransferParticipants } from '../employment/transfer-locks.js';
import { ensureOfferSignSource } from '../esign/offer-source.js';
import { RECORD_OBJECT, presentRecord, recordScope } from '../esign/record-access.js';
import { requireOfferSignSource } from '../esign/source-command-result.js';
import { runSourceSignCommand } from '../esign/source-initiation.js';
import { sourceTemplateOptions } from '../esign/source-templates.js';
import { parseBody, revision, uuidParam, type BusinessContext } from '../job/context.js';
import { getModuleViewableFieldsInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { objectContext } from '../permission/module-route-access.js';
import { EMPTY_SCOPE } from '../permission/scope-types.js';
import { assertOfferRevision } from './context.js';
import { currentEntryIds } from './entry-link.js';
import { loadOffer, lockOffer, type OfferRow } from './service.js';

const signInput = z.strictObject({ templateIds: z.array(z.uuid()).min(1).max(20) });
const pageInt = (max: number) => z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(max));
const recordsQuery = z.object({ page: pageInt(1_000_000).default(1), pageSize: pageInt(100).default(20) });

const SOURCE_UNAVAILABLE = 'ESIGN_SOURCE_UNAVAILABLE';
const OWNER_UNAVAILABLE = 'ESIGN_OWNER_UNAVAILABLE';

async function requireLiveOffer(tx: Tx, ctx: BusinessContext, id: string) {
  if ((await selectBusinessContent(tx, ctx, 'offer', id, ctx.userId.toLowerCase())).mode === 'frozen')
    throw new AppError('NOT_FOUND', 'Offer 不存在');
}

async function currentOfferContext(tx: Tx, deps: TenantRouteDeps, ctx: BusinessContext, pageCode?: string) {
  const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, OFFER_OBJECT, pageCode);
  return { ...ctx, scope };
}

/** 只读 Offer 已关联的员工标识，不将入站同步的系统范围带到签署入口。 */
async function resolveSignOwner(
  tx: Tx,
  ctx: BusinessContext,
  source: OfferRow,
  lockBusiness = false,
): Promise<{ employeeId: string } | { reason: typeof SOURCE_UNAVAILABLE | typeof OWNER_UNAVAILABLE }> {
  if (source.status !== 'accepted' && source.status !== 'onboarded') return { reason: SOURCE_UNAVAILABLE };
  if (source.pendingEntryBusinessId) {
    const current = (await currentEntryIds(tx, ctx.tenantId, [source])).get(source.id);
    const [owner] = rowsOf<{ employeeId: string }>(
      await tx.execute(sql`
        SELECT b.employee_id AS "employeeId" FROM employment_business_objects b
        JOIN LATERAL (
          SELECT state FROM employment_state_events
          WHERE tenant_id=b.tenant_id AND business_id=b.id ORDER BY event_no DESC LIMIT 1
        ) latest ON latest.state <> 'deleted'
        WHERE b.tenant_id=${ctx.tenantId} AND b.id=${current}::uuid
        ${lockBusiness ? sql`FOR UPDATE OF b` : sql``}
      `),
    );
    if (!owner || (source.linkedEmployeeId && source.linkedEmployeeId !== owner.employeeId))
      return { reason: SOURCE_UNAVAILABLE };
    return owner;
  }
  if (!source.linkedEmployeeId) return { reason: OWNER_UNAVAILABLE };
  const [owner] = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`SELECT id AS "employeeId" FROM employment_employees
      WHERE tenant_id=${ctx.tenantId} AND id=${source.linkedEmployeeId}::uuid`),
  );
  return owner ?? { reason: SOURCE_UNAVAILABLE };
}

function ownerForSign(result: Awaited<ReturnType<typeof resolveSignOwner>>) {
  if ('employeeId' in result) return result.employeeId;
  const message =
    result.reason === OWNER_UNAVAILABLE
      ? '尚无可用于签署的人员关联，请先完成现有同步或关联流程'
      : '当前 Offer 不可发起电子签署';
  throw new AppError('CONFLICT', message, { reason: result.reason });
}

async function lockSignSource(tx: Tx, deps: TenantRouteDeps, ctx: BusinessContext, id: string) {
  const source = await lockOffer(tx, await currentOfferContext(tx, deps, ctx), id);
  await requireLiveOffer(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, source.revision);
  const employeeId = ownerForSign(await resolveSignOwner(tx, ctx, source));
  // §5：先持 Offer 行锁，再锁员工闭包和业务头，最后由命令内核锁签署任务。
  await lockTransferParticipants(tx, { ...ctx, scope: EMPTY_SCOPE }, employeeId);
  const lockedOwner = ownerForSign(await resolveSignOwner(tx, ctx, source, true));
  if (lockedOwner !== employeeId)
    throw new AppError('CONFLICT', 'Offer 签署人员关联已变化', { reason: SOURCE_UNAVAILABLE });
  await ensureOfferSignSource(tx, ctx, id);
  return { employeeId, revision: source.revision, ownerDepartmentId: source.departmentId };
}

async function listOfferSignRecords(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: BusinessContext,
  sourceId: string,
  { page, pageSize }: z.infer<typeof recordsQuery>,
) {
  await loadOffer(tx, await currentOfferContext(tx, deps, ctx, `${OFFER_OBJECT}.detail`), sourceId);
  await requireLiveOffer(tx, ctx, sourceId);
  const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, RECORD_OBJECT, `${RECORD_OBJECT}.list`);
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, RECORD_OBJECT, tx);
  const where = and(
    eq(esignTasks.tenantId, ctx.tenantId),
    eq(esignTasks.scene, 'offer'),
    eq(esignTasks.offerId, sourceId),
    recordScope(scope),
  );
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
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
  return { items, total: count!.total, page, pageSize };
}

export function registerOfferESign(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.get('/:id/esign-context', async (c) => {
    const id = uuidParam(c);
    const ctx = await objectContext(c, deps, OFFER_OBJECT, 'update');
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        await requireOfferSignSource(tx, deps, ctx, id);
        const source = await lockOffer(tx, await currentOfferContext(tx, deps, ctx), id, 'share');
        await requireLiveOffer(tx, ctx, id);
        const owner = await resolveSignOwner(tx, ctx, source);
        const eligibility = 'reason' in owner ? { canInitiate: false, reason: owner.reason } : { canInitiate: true };
        return {
          sourceId: id,
          revision: source.revision,
          ...eligibility,
          ...(await sourceTemplateOptions(tx, ctx.tenantId)),
        };
      }),
    );
  });

  module.post('/:id/esign-tasks', async (c) => {
    const id = uuidParam(c);
    const ctx = await objectContext(c, deps, OFFER_OBJECT, 'update', revision(c));
    const { templateIds } = await parseBody(c, signInput);
    // DEC-968：实际路由的方法与路径对应 F-553 已登记的 OFFER_SIGN_COMMAND。
    const result = await runSourceSignCommand(deps.db, deps, ctx, {
      commandId: c.req.header('idempotency-key'),
      scene: 'offer',
      sourceId: id,
      templateIds,
      authorizeSource: async (tx) => {
        await requireOfferSignSource(tx, deps, ctx, id);
        await requireLiveOffer(tx, ctx, id);
      },
      lockSource: (tx, commandId) => lockSignSource(tx, deps, { ...ctx, commandId }, id),
    });
    return c.json(result.body, result.status);
  });

  module.get('/:id/esign-records', async (c: Context<TenantEnv>) => {
    const id = uuidParam(c);
    const ctx = await objectContext(c, deps, OFFER_OBJECT, 'view');
    await objectContext(c, deps, MODULE_OBJECTS.eSignRecord.code, 'view');
    const query = recordsQuery.safeParse(c.req.query());
    if (!query.success) throw new AppError('VALIDATION_FAILED', '签署记录分页参数不合法');
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => listOfferSignRecords(tx, deps, ctx, id, query.data)));
  });
}
