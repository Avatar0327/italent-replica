import { tenantOf } from '../../tenant-context.js';
import { rowsOf } from './store.js';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  button,
  JOB_OBJECT_CODES,
  objectContext,
  requestScope,
  visibleJob,
  writeFields,
} from '../permission/module-route-access.js';
import { authorizeInTransaction, resolveModuleScope } from '../permission/module-access.js';
import { parseBody, requireNew, revision, runWrite } from './context.js';
import { latestJobObject } from './read-model.js';
import { lockJobTenant } from './settings.js';
import { queueSequenceSync } from './sequence-sync.js';
import type { SequenceSource } from './sequence-targets.js';
const inputSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.uuid().transform((id) => id.toLowerCase()),
        revision: z.number().int().min(1),
      }),
    )
    .min(1)
    .max(100),
});
export function registerSequenceSyncRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/api/tenant/job/sequence-sync/messages', async (c) => {
    const ctx = tenantOf(c);
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) =>
      rowsOf(
        await tx.execute(sql`
      SELECT id,created_at AS "createdAt",payload->'after' AS message FROM employment_outbox
      WHERE tenant_id=${ctx.tenantId} AND event_type='job.sequence-sync.completed'
        AND payload->'after'->>'recipientUserId'=${ctx.userId}
      ORDER BY created_at DESC,id DESC LIMIT 20`),
      ),
    );
    return c.json({ items });
  });
  router.get('/api/tenant/job/sequence-sync/tasks/:id', async (c) => {
    const ctx = tenantOf(c);
    const parsed = z.uuid().safeParse(c.req.param('id'));
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '任务 ID 不合法');
    const task = await withTenant(
      deps.db,
      ctx.tenantId,
      async (tx) =>
        rowsOf(
          await tx.execute(sql`
      SELECT o.id, (SELECT state FROM employment_outbox_attempts a WHERE a.tenant_id=o.tenant_id AND a.outbox_id=o.id
        ORDER BY attempt_no DESC LIMIT 1) AS state,
        (SELECT payload->'after' FROM employment_outbox done WHERE done.tenant_id=o.tenant_id

      AND done.event_type='job.sequence-sync.completed'
          AND done.payload->'after'->>'taskId'=o.id::text LIMIT 1) AS result
      FROM employment_outbox o WHERE o.tenant_id=${ctx.tenantId} AND o.id=${parsed.data}::uuid
        AND o.event_type='job.sequence-sync.requested' AND o.payload->'after'->>'recipientUserId'=${ctx.userId}
    `),
        )[0],
    );
    if (!task) throw new AppError('NOT_FOUND', '任务不存在');
    return c.json(task);
  });
  for (const kind of ['posts', 'positions'] as const) {
    router.post(`/api/tenant/job/${kind}/sync-sequence`, async (c) => {
      const code = JOB_OBJECT_CODES[kind];
      const ctx = await objectContext(c, deps, code, undefined, revision(c));
      requireNew(ctx);
      await button(deps, ctx, code, 'syncSequence', 'list');
      const input = await parseBody(c, inputSchema);
      if (new Set(input.items.map((item) => item.id)).size !== input.items.length)
        throw new AppError('VALIDATION_FAILED', '勾选对象不得重复');
      const scope = await requestScope(c, deps, ctx, code);
      const employmentScope = await resolveModuleScope(deps, ctx, undefined, MODULE_OBJECTS.employmentRecord.code);
      const today = tenantLocalDate(ctx.now, ctx.timezone);
      // 幂等重放仍先按当前对象可见范围校验，不能靠旧命令读取跨租户或已撤权的对象。
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        for (const item of input.items) await visibleJob(tx, ctx, scope, kind, item.id, today);
      });
      return runWrite(c, deps, ctx, input, async (tx, writeCtx) => {
        await lockJobTenant(tx, writeCtx);
        const sources: SequenceSource[] = [];
        for (const item of input.items) {
          await visibleJob(tx, ctx, scope, kind, item.id, today);
          const record = await latestJobObject(tx, ctx.tenantId, kind, item.id);
          if (!record) throw new AppError('NOT_FOUND', '职务体系对象不存在');
          if (record.revision !== item.revision) throw new AppError('REVISION_CONFLICT', '对象已修改，请刷新后重提');
          if (record.sequenceId) {
            await writeFields({ ...deps, authorize: authorizeInTransaction(deps.authorize, tx) }, ctx, code, 'update', {
              sequenceId: record.sequenceId,
            });
            sources.push({ kind, id: item.id, sequenceId: record.sequenceId, revision: item.revision });
          }
        }
        const taskId = await queueSequenceSync(tx, writeCtx, sources, {
          scope: employmentScope,
          authorize: deps.authorize,
        });
        return { status: 202, body: { taskId, state: 'pending' } };
      });
    });
  }
}
