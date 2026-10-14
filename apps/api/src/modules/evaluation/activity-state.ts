/** 活动整体操作只检查活动授权（DEC-320②），不对活动内人员做全覆盖检查。 */
import { sql, type Tx } from '@italent/db';
import { button } from '../permission/module-route-access.js';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { parseBody, revision, uuidParam } from '../talent/http.js';
import { codeOf, evaluationContext, requireVisible, trimEvaluation } from './access.js';
import { loadActivity } from './activity-service.js';
import { assertScopeUnique } from './activity-scope.js';
import { registerNotification } from './flow-service.js';
import { coordinateActivityForms } from './reference-locks.js';
import { EV_BASE } from './route-support.js';
import { audit, lockEditable, rowAccess, type WriteContext } from './store.js';

const OBJECT = 'evaluationActivity';
const PATH = `${EV_BASE}/activities`;
type Action = 'publish' | 'unpublish';
const empty = z.object({}).strict();

async function changeState(tx: Tx, ctx: WriteContext, id: string, action: Action, nameVisible: boolean) {
  // 和 B5 / B6 相同：协调锁 → 活动行 → 类别范围锁，禁止另起反向取锁协议。
  await coordinateActivityForms(tx, ctx.tenantId);
  const row = await lockEditable(tx, ctx, OBJECT, id);
  if (row.status !== (action === 'publish' ? 'draft' : 'published'))
    throw new AppError('CONFLICT', '活动状态不允许此操作', { reason: 'ACTIVITY_STATE' });
  if (action === 'unpublish' && Number(row.apply_count) > 0)
    throw new AppError('CONFLICT', '已有报名，不能取消发布', { reason: 'ACTIVITY_HAS_APPLICANTS' });
  if (action === 'publish') {
    const activity = await loadActivity(tx, ctx.tenantId, id);
    await assertScopeUnique(tx, {
      ...ctx,
      selfId: id,
      orgRange: activity.orgRange,
      categoryIds: activity.categoryIds,
      nameVisible,
    });
    await registerNotification(tx, ctx, {
      activityId: id,
      kind: 'activity_published',
      dedupeKey: `activity-published:${id}:${row.revision}`,
    });
  }
  const status = action === 'publish' ? 'published' : 'draft';
  await tx.execute(sql`UPDATE ev_activities SET status=${status}, revision=revision+1,
    updated_at=${ctx.now.toISOString()}::timestamptz WHERE tenant_id=${ctx.tenantId}::uuid AND id=${id}::uuid`);
  await audit(tx, ctx, OBJECT, action, id, {
    before: { status: row.status },
    after: { status },
    orgId: row.owner_org_id as string,
  });
  return { id, revision: Number(row.revision) + 1, status };
}

async function activityCommand(c: Context<TenantEnv>, deps: TenantRouteDeps, action: Action) {
  const id = uuidParam(c);
  const expectedRevision = revision(c);
  const ctx = await evaluationContext(c, deps, OBJECT, 'update', expectedRevision);
  await button(deps, ctx, codeOf(OBJECT), action, 'list_row');
  const body = await parseBody(c, empty);
  let current: WriteContext;
  let nameVisible = false;
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision, input: body },
    guard: {
      before: async (tx) => {
        const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
        const fresh = await evaluationContext(c, bound, OBJECT, 'update', expectedRevision);
        await button(bound, fresh, codeOf(OBJECT), action, 'list_row');
        current = { ...fresh, scope: await resolveModuleScopeInTransaction(bound, fresh, tx, codeOf(OBJECT)) };
        const fields = await getModuleViewableFieldsInTransaction(bound, fresh, codeOf(OBJECT), tx);
        nameVisible = fields === undefined || fields.has('name');
        requireVisible((await rowAccess(tx, fresh, current.scope, OBJECT, id)).visible, OBJECT);
      },
      replayed: async (tx) => {
        requireVisible((await rowAccess(tx, current, current.scope, OBJECT, id)).visible, OBJECT);
      },
    },
    execute: async (tx, commandId) => ({
      status: 200,
      body: await changeState(tx, { ...current, commandId }, id, action, nameVisible),
    }),
  });
  const value = result.body as { id: string; revision: number; status: string };
  c.header('ETag', `"${value.revision}"`);
  return c.json((await trimEvaluation(deps, ctx, OBJECT, [value]))[0], result.status);
}
export function registerActivityStateRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${PATH}/:id/publish`, (c) => activityCommand(c, deps, 'publish'));
  router.post(`${PATH}/:id/unpublish`, (c) => activityCommand(c, deps, 'unpublish'));
}
