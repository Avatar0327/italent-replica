import {
  and,
  desc,
  eq,
  establishmentSchemeObjects,
  establishmentSchemeVersions,
  isUuid,
  lte,
  withTenant,
} from '@italent/db';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, queryDate, readContext, revision, runWrite, uuidParam } from '../job/context.js';
import { validIsoDate } from '../org/read-model.js';
import { listCapacities, readCapacity } from './capacity-read.js';
import { createCapacity, updateCapacity } from './capacity-service.js';
import { enqueueCopyJob, executeCopyJob, listNotifications, readCopyJob, readCopyJobReport } from './copy-service.js';
import { createScheme, deleteScheme, loadScheme, updateScheme } from './schemes.js';
import { readSettings, updateSettings } from './settings.js';

const BASE = '/api/tenant/establishment';
const date = z.string().refine(validIsoDate, '日期必须为合法 YYYY-MM-DD');
const amount = z.number().int().min(0).max(2_147_483_647);
const scheme = z.strictObject({
  name: z.string().trim().min(1).max(200),
  code: z.string().min(1).max(64).optional(),
  periodType: z.enum(['annual', 'quarterly', 'monthly']),
  maintenanceMode: z.enum(['local', 'inclusive', 'both']),
  startMonth: z.number().int().min(1).max(12).optional(),
  subdivision: z.enum(['none', 'position']).optional(),
  unmatchedPolicy: z.enum(['organization', 'reject']).optional(),
  enabled: z.boolean().optional(),
  startDate: date.optional(),
  stopDate: date.optional(),
  excludedOrgIds: z.array(z.uuid()).max(100).optional(),
  occupancyRanges: z
    .array(z.strictObject({ employmentType: z.string().trim().min(1).max(100) }))
    .max(5)
    .optional(),
});
const schemePatch = scheme.partial().extend({ effectiveDate: date });
const capacity = z.strictObject({
  orgId: z.uuid(),
  schemeId: z.uuid(),
  periodStart: date,
  effectiveDate: date.optional(),
  localCapacity: amount.nullable().optional(),
  inclusiveCapacity: amount.nullable().optional(),
  reservedLocal: amount.optional(),
  reservedInclusive: amount.optional(),
  strictControl: z.boolean().optional(),
  syncParents: z.boolean().optional(),
  subdivisions: z
    .array(
      z.strictObject({ positionId: z.uuid(), localCapacity: amount.nullable(), inclusiveCapacity: amount.nullable() }),
    )
    .max(100)
    .optional(),
});
const capacityPatch = capacity.partial().extend({ effectiveDate: date, adjustmentThrough: date.optional() });
const settings = z.strictObject({
  transferIn: z.enum(['submitted', 'approved']),
  transferOut: z.enum(['submitted', 'approved']),
  effectiveDate: date.optional(),
});

export function registerEstablishmentRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerSchemes(router, deps);
  registerCapacities(router, deps);
  registerTiming(router, deps);
  registerCopyJobs(router, deps);
}

function registerSchemes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(`${BASE}/schemes`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.read');
    const asOf = queryDate(c, ctx);
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const selected = await tx
        .selectDistinctOn([establishmentSchemeVersions.schemeId], { id: establishmentSchemeObjects.id })
        .from(establishmentSchemeVersions)
        .innerJoin(
          establishmentSchemeObjects,
          and(
            eq(establishmentSchemeObjects.id, establishmentSchemeVersions.schemeId),
            eq(establishmentSchemeObjects.tenantId, establishmentSchemeVersions.tenantId),
          ),
        )
        .where(
          and(eq(establishmentSchemeVersions.tenantId, ctx.tenantId), lte(establishmentSchemeVersions.startDate, asOf)),
        )
        .orderBy(
          establishmentSchemeVersions.schemeId,
          desc(establishmentSchemeVersions.startDate),
          desc(establishmentSchemeVersions.versionNo),
        )
        .limit(page.limit)
        .offset(page.offset);
      const records = [];
      for (const row of selected) {
        try {
          records.push(await loadScheme(tx, ctx.tenantId, row.id, asOf));
        } catch (error) {
          if (!(error instanceof AppError && error.code === 'NOT_FOUND')) throw error;
        }
      }
      return records;
    });
    return c.json({ items });
  });
  router.get(`${BASE}/schemes/:id`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.read');
    const id = uuidParam(c);
    const asOf = queryDate(c, ctx);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => loadScheme(tx, ctx.tenantId, id, asOf)));
  });
  router.post(`${BASE}/schemes`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.write', revision(c));
    const input = await parseBody(c, scheme);
    return runWrite(c, deps, ctx, input, async (tx, commandCtx) => ({
      status: 201,
      body: await createScheme(tx, commandCtx, input),
    }));
  });
  router.patch(`${BASE}/schemes/:id`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.write', revision(c));
    const id = uuidParam(c);
    const input = await parseBody(c, schemePatch);
    return runWrite(c, deps, ctx, input, async (tx, commandCtx) => ({
      status: 200,
      body: await updateScheme(tx, commandCtx, id, input),
    }));
  });
  router.delete(`${BASE}/schemes/:id`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.write', revision(c));
    const id = uuidParam(c);
    return runWrite(c, deps, ctx, {}, async (tx, commandCtx) => ({
      status: 200,
      body: await deleteScheme(tx, commandCtx, id),
    }));
  });
}

function registerCapacities(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(`${BASE}/capacities`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.read');
    const asOf = queryDate(c, ctx);
    const page = pageQuery(c);
    const orgId = queryUuid(c, 'orgId');
    const schemeId = queryUuid(c, 'schemeId');
    const periodStart = c.req.query('periodStart');
    if (periodStart && !validIsoDate(periodStart)) throw new AppError('VALIDATION_FAILED', '周期日期不合法');
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listCapacities(tx, ctx.tenantId, asOf, { orgId, schemeId, periodStart }, page),
    );
    return c.json({ items });
  });
  router.get(`${BASE}/capacities/:id`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.read');
    const id = uuidParam(c);
    const asOf = queryDate(c, ctx);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => readCapacity(tx, ctx.tenantId, id, asOf)));
  });
  router.post(`${BASE}/capacities`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.write', revision(c));
    const input = await parseBody(c, capacity);
    return runWrite(c, deps, ctx, input, async (tx, commandCtx) => ({
      status: 201,
      body: await createCapacity(tx, commandCtx, input),
    }));
  });
  router.patch(`${BASE}/capacities/:id`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.write', revision(c));
    const id = uuidParam(c);
    const input = await parseBody(c, capacityPatch);
    return runWrite(c, deps, ctx, input, async (tx, commandCtx) => ({
      status: 200,
      body: await updateCapacity(tx, commandCtx, id, input),
    }));
  });
}

function registerTiming(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(`${BASE}/settings`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.read');
    const asOf = queryDate(c, ctx);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => readSettings(tx, ctx.tenantId, asOf)));
  });
  router.put(`${BASE}/settings`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.write', revision(c));
    const input = await parseBody(c, settings);
    return runWrite(c, deps, ctx, input, async (tx, commandCtx) => ({
      status: 200,
      body: await updateSettings(tx, commandCtx, input),
    }));
  });
}

function registerCopyJobs(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${BASE}/copy-jobs`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.write', revision(c));
    const input = await parseBody(c, z.strictObject({ capacityIds: z.array(z.uuid()).min(1).max(100) }));
    return runWrite(c, deps, ctx, input, async (tx, commandCtx) => ({
      status: 202,
      body: await enqueueCopyJob(tx, commandCtx, input),
    }));
  });
  router.get(`${BASE}/copy-jobs/:id`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.read');
    const id = uuidParam(c);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => readCopyJob(tx, ctx.tenantId, id)));
  });
  router.post(`${BASE}/copy-jobs/:id/execute`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.write', revision(c));
    const id = uuidParam(c);
    const input = await parseBody(c, z.strictObject({}));
    return runWrite(c, deps, ctx, input, async (tx, commandCtx) => ({
      status: 200,
      body: await executeCopyJob(tx, commandCtx, id),
    }));
  });
  router.get(`${BASE}/copy-jobs/:id/report`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.read');
    const id = uuidParam(c);
    const report = await withTenant(deps.db, ctx.tenantId, (tx) => readCopyJobReport(tx, ctx, id));
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${report.filename}"`);
    return c.body(report.content);
  });
  router.get(`${BASE}/notifications`, async (c) => {
    const ctx = await readContext(c, deps, 'tenant.establishment.read');
    const page = pageQuery(c);
    return c.json({
      items: await withTenant(deps.db, ctx.tenantId, (tx) => listNotifications(tx, ctx.tenantId, ctx.userId, page)),
    });
  });
}

function queryUuid(c: Context, name: string): string | undefined {
  const value = c.req.query(name);
  if (value !== undefined && !isUuid(value)) throw new AppError('VALIDATION_FAILED', `${name} 必须为UUID`);
  return value;
}
