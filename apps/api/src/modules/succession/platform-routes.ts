/** #19 后半：平台运营按显式租户逐页重编译；P0 登记位，不经过租户成员或租户对象权限。 */
import { APP_ROLE, sql, type Db, type Tx } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { defaultAuthorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import { defineTable } from '../../route-policy/index.js';
import { none, platform, write } from '../../route-policy/presets.js';
import { operatorOf, type PlatformEnv } from '../platform/context.js';
import { requireTenant } from '../platform/operations.js';
import { dispatchCalcJobs, SUCCESSION_PRODUCERS } from './calc-jobs.js';
import { recompilePopulations } from './config-write.js';
import { populationViews, type ConfigView } from './config-store.js';
import { rowsOf } from './read-sql.js';
import { authorizeSuccessionResult, type ResultAdapter, type StoredResult } from './write-support.js';

export interface PlatformRouteDeps {
  readonly db: Db;
  readonly clock: () => Date;
}
const PATH = '/api/platform/succession/rules/recompile';
export const SUCCESSION_PLATFORM_POLICIES = defineTable('succession-platform', {
  'POST /api/platform/succession/jobs/run': platform({
    write: write(none('平台按租户生产及推进计算任务'), 'succession.platformRecheck', 'succession.platformRecheck', {
      ledger: 'single',
      commandOnly: true,
    }),
  }),
  [`POST ${PATH}`]: platform({
    write: write(none('平台重编译命令，无人工业务字段'), 'succession.platformRecheck', 'succession.authorizeResult', {
      ledger: 'single',
      commandOnly: true,
    }),
  }),
});
const input = z.strictObject({
  tenantId: z.uuid().transform((id) => id.toLowerCase()),
  cursor: z
    .uuid()
    .transform((id) => id.toLowerCase())
    .optional(),
});

/** #199：首次执行、直接重放、失败回查共用此事务内的平台身份复核。角色在同一事务内恢复，不另开嵌套事务。 */
export async function recheckPlatform(tx: Tx, userId: string) {
  await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.platform}`));
  try {
    const [row] = rowsOf<{ active: boolean }>(
      await tx.execute(sql`SELECT true AS active FROM platform_operators p
      JOIN users u ON u.id = p.user_id WHERE p.user_id = ${userId}::uuid
      AND p.status = 'active' AND u.status = 'active'`),
    );
    if (!row?.active) throw new AppError('FORBIDDEN', '仅平台运营身份可重新编译规则');
  } finally {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.tenant}`));
  }
}
const platformResults: ResultAdapter<ConfigView> = {
  object: 'population',
  async load(tx, _deps, ctx, ids) {
    await recheckPlatform(tx, ctx.userId);
    const views = await populationViews(tx, ctx.tenantId, ids);
    return { views, revisions: new Map(views.map((view) => [view.id, view.revision])) };
  },
  async project(_deps, _ctx, views) {
    return views.map(({ id, revision, compileError }) => ({ id, revision, compileError }));
  },
};
export function registerSuccessionPlatformRoutes(router: Hono<PlatformEnv>, deps: PlatformRouteDeps): void {
  router.post('/api/platform/succession/jobs/run', async (c) => {
    const parsed = z
      .strictObject({
        kind: z.enum(['exit_sweep', 'position_risk', 'org_stats', 'org_health', 'org_health_reset']),
        tenantId: z
          .uuid()
          .transform((id) => id.toLowerCase())
          .optional(),
        cursor: z
          .uuid()
          .transform((id) => id.toLowerCase())
          .optional(),
      })
      .safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success || (parsed.data.tenantId && parsed.data.cursor))
      throw new AppError('VALIDATION_FAILED', '调度参数不合法，单租户与游标不能同时指定');
    return c.json(
      await dispatchCalcJobs(
        deps,
        { ...parsed.data, userId: operatorOf(c).userId, commandId: c.req.header('idempotency-key') },
        SUCCESSION_PRODUCERS,
      ),
    );
  });
  router.post(PATH, async (c) => {
    const parsed = input.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '重新编译参数不合法');
    const body = parsed.data;
    const tenant = await requireTenant(deps.db, body.tenantId);
    const ctx = {
      tenantId: tenant.id,
      userId: operatorOf(c).userId,
      timezone: tenant.timezone,
      now: deps.clock(),
      expectedRevision: 0,
      commandId: '',
    };
    const resultDeps = { ...deps, authorize: defaultAuthorizer };
    const response = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { path: PATH, body },
      guard: {
        before: (tx) => recheckPlatform(tx, ctx.userId),
        replayed: async (tx, replay) => {
          const result = replay.body as StoredResult;
          const loaded = await platformResults.load(tx, resultDeps, ctx, result.ids, { includeDeleted: false });
          if (loaded.views.length !== result.ids.length) throw new AppError('NOT_FOUND', '规则不存在');
        },
      },
      execute: async (tx, commandId) => ({
        status: 200,
        body: {
          kind: 'records',
          commandId,
          ids: await recompilePopulations(tx, { ...ctx, commandId }, body.cursor),
        } satisfies StoredResult,
      }),
    });
    const result = response.body as StoredResult;
    const { items } = await authorizeSuccessionResult(resultDeps, ctx, result, platformResults);
    return c.json({ items, nextCursor: result.ids.length === 200 ? result.ids.at(-1) : null });
  });
}
