/** B7a 项目接口（设计 §7）：命令 ledgerExit → guard.before 复核；管理范围用统一 scopeSql / visible；B7b 扩展只读谓词。 */
import { and, asc, eq, talentReviewProjects as P, withTenant, type Tx } from '@italent/db';
import type { Context, Hono } from 'hono';
import { useMiddleware } from '../../route-policy/index.js';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { button } from '../permission/module-route-access.js';
import { pageQuery, parseBody, requireNew, revision, uuidParam } from '../talent/http.js';
import {
  checkWriteFields,
  codeOf,
  notFoundMessage,
  reviewContext,
  reviewScope,
  reviewWriteContext,
  TALENT_REVIEW_BASE,
  trimReview,
  type TalentReviewContext,
} from './access.js';
import { visibleOrder } from './config-kit.js';
import { projectActionBody, projectCreate, projectPatch, type ProjectPatch } from './project-input.js';
import { checkProjectReferences, referenceKinds, type ProjectWriteContext } from './project-references.js';
import { loadProject, projectHeader, type ProjectView } from './project-store.js';
import { createProject, deleteProject, transitionProject, updateProject } from './project-service.js';
import type { ProjectAction } from './project-guards.js';

import {
  projectReadable,
  projectListAccess,
  requireProjectReadable,
  requireProjectEditable,
} from './project-access.js';

const PATH = `${TALENT_REVIEW_BASE}/projects`;
type Action = 'create' | 'update' | 'delete' | ProjectAction;
async function projectWriteContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  action: Action,
  expectedRevision: number,
) {
  if (action === 'create' || action === 'update' || action === 'delete') {
    return reviewWriteContext(c, deps, 'project', action, expectedRevision);
  }
  const ctx = await reviewContext(c, deps, 'project', 'update', expectedRevision);
  await button(deps, ctx, codeOf('project'), action, 'detail');
  return ctx;
}
async function requireProjectCatalogs(c: Context<TenantEnv>, deps: TenantRouteDeps, input: ProjectPatch) {
  for (const key of referenceKinds(input)) await reviewContext(c, deps, key);
}
async function runWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  action: Action,
  input: ProjectPatch,
  execute: (tx: Tx, ctx: ProjectWriteContext) => Promise<ProjectView>,
  recheckInput?: (deps: TenantRouteDeps, ctx: ProjectWriteContext) => Promise<void>,
) {
  let current: ProjectWriteContext;
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input },
    guard: {
      before: async (tx) => {
        const txDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
        const fresh = await projectWriteContext(c, txDeps, action, ctx.expectedRevision);
        const scope = await resolveModuleScopeInTransaction(txDeps, fresh, tx, codeOf('project'));
        const referenceScopes: ProjectWriteContext['referenceScopes'] = {};
        for (const key of referenceKinds(input)) {
          referenceScopes[key] = await resolveModuleScopeInTransaction(txDeps, fresh, tx, codeOf(key));
        }
        current = { ...fresh, scope, referenceScopes };
        await recheckInput?.(txDeps, current);
      },
      replayed: async (tx, replay) => {
        const view = replay.body as ProjectView;
        const anchor = action === 'delete' ? view : await projectHeader(tx, ctx.tenantId, view.id);
        if (!anchor) throw new AppError('NOT_FOUND', notFoundMessage('project'));
        await requireProjectEditable(tx, current, current.scope, anchor);
        await checkProjectReferences(tx, current, input, view, true);
      },
    },
    execute: async (tx, commandId) => ({
      status: action === 'create' ? 201 : 200,
      body: await execute(tx, { ...current!, commandId }),
    }),
  });
  const view = result.body as ProjectView;
  if (action !== 'delete') c.header('ETag', `"${view.revision}"`);
  return c.json({ ...(await trimReview(deps, ctx, 'project', [view]))[0], accessLevel: 'manage' }, result.status);
}

async function projectList(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const ctx = await reviewContext(c, deps, 'project');
  const scope = await reviewScope(c, deps, ctx, 'project');
  const page = pageQuery(c);
  const viewable = await getModuleViewableFields(deps, ctx, codeOf('project'));
  const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: P.id })
      .from(P)
      .where(and(eq(P.tenantId, ctx.tenantId), projectReadable(ctx, scope)))
      .orderBy(...visibleOrder([['name', P.name]], viewable).map((col) => asc(col)), asc(P.id))
      .limit(page.limit)
      .offset(page.offset)
      .for('share');
    const views: ProjectView[] = [];
    for (const row of rows) views.push((await loadProject(tx, ctx.tenantId, row.id))!);
    return views;
  });
  return c.json({
    page: page.page,
    pageSize: page.pageSize,
    hasDataPermission: scope.all || scope.hasDataPermission,
    items: (await trimReview(deps, ctx, 'project', items)).map((view, index) => ({
      ...view,
      accessLevel: projectListAccess(scope, items[index]!),
    })),
  });
}

export function registerProjectRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  useMiddleware(router, `${PATH}/:id/*`, async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.path !== `${PATH}/${c.req.param('id')}`) {
      const ctx = await reviewContext(c, deps, 'project', 'update');
      const id = uuidParam(c);
      const scope = await reviewScope(c, deps, ctx, 'project');
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const anchor = await projectHeader(tx, ctx.tenantId, id);
        if (!anchor) throw new AppError('NOT_FOUND', notFoundMessage('project'));
        await requireProjectEditable(tx, ctx, scope, anchor);
      });
    }
    await next();
  });
  router.get(PATH, (c) => projectList(c, deps));
  router.get(`${PATH}/:id`, async (c) => {
    const ctx = await reviewContext(c, deps, 'project');
    const id = uuidParam(c);
    const scope = await reviewScope(c, deps, ctx, 'project');
    const view = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const found = await loadProject(tx, ctx.tenantId, id);
      if (!found) throw new AppError('NOT_FOUND', notFoundMessage('project'));
      const accessLevel = await requireProjectReadable(tx, ctx, scope, found);
      return { found, accessLevel };
    });
    c.header('ETag', `"${view.found.revision}"`);
    return c.json({ ...(await trimReview(deps, ctx, 'project', [view.found]))[0], accessLevel: view.accessLevel });
  });
  router.post(PATH, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'project', 'create', revision(c));
    requireNew(ctx.expectedRevision);
    const input = await parseBody(c, projectCreate);
    await requireProjectCatalogs(c, deps, input);
    return runWrite(
      c,
      deps,
      ctx,
      'create',
      input,
      (tx, w) => createProject(tx, w, input),
      async (d, w) => {
        await checkWriteFields(d, w, 'project', 'create', input);
        await requireProjectCatalogs(c, d, input);
      },
    );
  });
  router.patch(`${PATH}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'project', 'update', revision(c));
    const id = uuidParam(c);
    const input = await parseBody(c, projectPatch);
    await requireProjectCatalogs(c, deps, input);
    return runWrite(
      c,
      deps,
      ctx,
      'update',
      input,
      (tx, w) => updateProject(tx, w, id, input),
      async (d, w) => {
        await checkWriteFields(d, w, 'project', 'update', input);
        await requireProjectCatalogs(c, d, input);
      },
    );
  });
  router.delete(`${PATH}/:id`, async (c) => {
    const ctx = await reviewWriteContext(c, deps, 'project', 'delete', revision(c));
    const id = uuidParam(c);
    return runWrite(c, deps, ctx, 'delete', {}, (tx, w) => deleteProject(tx, w, id));
  });
  for (const action of ['start', 'end', 'restart'] as const) {
    router.post(`${PATH}/:id/${action}`, async (c) => {
      const ctx = await projectWriteContext(c, deps, action, revision(c));
      const id = uuidParam(c);
      const input = await parseBody(c, projectActionBody);
      return runWrite(c, deps, ctx, action, input, (tx, w) => transitionProject(tx, w, id, action));
    });
  }
}
