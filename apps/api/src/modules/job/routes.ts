import { withTenant } from '@italent/db';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, queryDate, readContext, requireNew, revision, runWrite, uuidParam } from './context.js';
import { businessDate, jobCreationSchema, jobPatchSchema } from './fields.js';
import { importJobObjects, type JobImportRow } from './import-service.js';
import { JOB_KINDS, type JobKind } from './metadata.js';
import { jobCandidates, listJobObjects, loadJobObject } from './read-model.js';
import { jobSettingsSchema, readJobSettings, writeJobSettings } from './settings.js';
import type { JobInput, JobPatch } from './types.js';
import { validateJobAssignment } from './validation.js';
import { createJobObject, updateJobObject } from './write-service.js';

const BASE = '/api/tenant/job';
const assignment = z.strictObject({
  postId: z.uuid(),
  levelId: z.uuid().optional(),
  gradeId: z.uuid().optional(),
  asOf: businessDate,
});

export function registerJobRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerSettings(router, deps);
  registerCandidates(router, deps);
  registerImport(router, deps);
  registerObjects(router, deps);
}

function registerSettings(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${BASE}/settings`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.job.read');
    const asOf = queryDate(c, ctx);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) => readJobSettings(tx, ctx.tenantId, asOf));
    c.header('ETag', `"${result.revision}"`);
    return c.json(result);
  });
  router.put(`${BASE}/settings`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.job.write', revision(c));
    const input = await parseBody(c, jobSettingsSchema);
    return runWrite(c, deps, ctx, input, async (tx, writeCtx) => ({
      status: 200,
      body: await writeJobSettings(tx, writeCtx, input),
    }));
  });
}

function registerCandidates(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  for (const kind of ['levels', 'grades'] as const) {
    router.get(`${BASE}/candidates/${kind}`, async (c) => {
      const ctx = await readContext(c, deps, 'tenant.job.read');
      const postId = z.uuid().safeParse(c.req.query('postId'));
      const levelId = z.uuid().optional().safeParse(c.req.query('levelId'));
      if (!postId.success || !levelId.success) throw new AppError('VALIDATION_FAILED', '职务或职级 ID 不合法');
      const page = pageQuery(c);
      const input = { postId: postId.data, levelId: levelId.data, asOf: queryDate(c, ctx), ...page };
      const items = await withTenant(deps.db, ctx.tenantId, (tx) => jobCandidates(tx, ctx.tenantId, input, kind));
      return c.json({ items, page: page.page, pageSize: page.pageSize });
    });
  }
  router.post(`${BASE}/validate-assignment`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.job.write');
    const input = await parseBody(c, assignment);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) => validateJobAssignment(tx, ctx.tenantId, input));
    return c.json(result);
  });
}

function registerImport(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(`${BASE}/import`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.job.write', revision(c));
    requireNew(ctx);
    const input = await parseBody(
      c,
      z.strictObject({
        kind: z.enum(JOB_KINDS),
        rows: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
      }),
    );
    const row = jobCreationSchema(input.kind).extend({
      sourceCode: z.string().trim().min(1).max(100),
      objectId: z.uuid().optional(),
      expectedRevision: z.number().int().min(1).optional(),
    });
    const parsed = z.array(row).safeParse(input.rows);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '导入行字段不合法', parsed.error.issues);
    return runWrite(c, deps, ctx, input, async (tx, writeCtx) => ({
      status: 200,
      body: await importJobObjects(tx, writeCtx, input.kind, parsed.data as JobImportRow[]),
    }));
  });
}

function registerObjects(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${BASE}/:kind`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.job.read');
    const kind = objectKind(c);
    const page = pageQuery(c);
    const orgId = z.uuid().optional().safeParse(c.req.query('orgId'));
    if (!orgId.success) throw new AppError('VALIDATION_FAILED', '组织 ID 不合法');
    const enabled = enabledFilter(c);
    const query = { asOf: queryDate(c, ctx), name: c.req.query('name'), orgId: orgId.data, enabled, ...page };
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listJobObjects(tx, ctx.tenantId, kind, query));
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
  router.get(`${BASE}/:kind/:id`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.job.read');
    const kind = objectKind(c);
    const id = uuidParam(c);
    const asOf = queryDate(c, ctx);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) =>
      loadJobObject(tx, ctx.tenantId, kind, id, asOf, true),
    );
    if (!result) throw new AppError('NOT_FOUND', '职务体系对象不存在或已失效');
    c.header('ETag', `"${result.revision}"`);
    return c.json(result);
  });
  router.post(`${BASE}/:kind`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.job.write', revision(c));
    requireNew(ctx);
    const kind = objectKind(c);
    const input = await parseBody(c, jobCreationSchema(kind));
    return runWrite(c, deps, ctx, input, async (tx, writeCtx) => ({
      status: 201,
      body: await createJobObject(tx, writeCtx, kind, input as JobInput),
    }));
  });
  router.patch(`${BASE}/:kind/:id`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.job.write', revision(c));
    const kind = objectKind(c);
    const id = uuidParam(c);
    const input = await parseBody(c, jobPatchSchema(kind));
    return runWrite(c, deps, ctx, input, async (tx, writeCtx) => ({
      status: 200,
      body: await updateJobObject(tx, writeCtx, kind, id, input as JobPatch),
    }));
  });
}

function objectKind(c: Context): JobKind {
  const parsed = z.enum(JOB_KINDS).safeParse(c.req.param('kind'));
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '职务体系类型不合法');
  return parsed.data;
}

function enabledFilter(c: Context): boolean | undefined {
  const enabled = c.req.query('enabled');
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') {
    throw new AppError('VALIDATION_FAILED', '启用状态不合法');
  }
  if (enabled !== undefined) return enabled === 'true';
  const include = c.req.query('includeDisabled');
  if (include !== undefined && include !== 'true' && include !== 'false') {
    throw new AppError('VALIDATION_FAILED', '包含停用状态不合法');
  }
  return include === 'true' ? undefined : true;
}
