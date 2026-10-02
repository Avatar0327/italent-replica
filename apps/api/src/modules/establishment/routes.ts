import {
  and,
  desc,
  eq,
  establishmentObjects,
  establishmentSchemeObjects,
  establishmentSchemeVersions,
  isUuid,
  lte,
  sql,
  withTenant,
  type Tx,
} from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext, TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, queryDate, readContext, revision, runWrite, uuidParam } from '../job/context.js';
import {
  button,
  creatorOf,
  creatorSql,
  hasCreatorScope,
  objectContext,
  requestScope,
  trimModuleResponse,
  visible,
  writeFields,
  type ModuleScope,
} from '../permission/module-route-access.js';
import { getModuleViewableFields, scopeSql } from '../permission/module-access.js';
import { validIsoDate } from '../org/read-model.js';
import { listCapacities, readCapacity, type CapacityRecord } from './capacity-read.js';
import { capacityContext } from '../permission/module-capacity-authorization.js';
import { createCapacity, updateCapacity } from './capacity-service.js';
import { enqueueCopyJob, executeCopyJob, listNotifications, readCopyJob, readCopyJobReport } from './copy-service.js';
import { createScheme, deleteScheme, loadScheme, loadSchemeBatch, updateScheme } from './schemes.js';
import { readSettings, updateSettings } from './settings.js';

const BASE = '/api/tenant/establishment';
const OBJECT = MODULE_OBJECTS.establishment.code;
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
  registerSchemeWrites(router, deps);
  registerCapacities(router, deps);
  registerTiming(router, deps);
  registerCopyJobs(router, deps);
}

function registerSchemes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(`${BASE}/schemes`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT);
    const asOf = queryDate(c, ctx);
    const page = pageQuery(c);
    const scope = await requestScope(c, deps, ctx, OBJECT);
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
          and(
            eq(establishmentSchemeVersions.tenantId, ctx.tenantId),
            lte(establishmentSchemeVersions.startDate, asOf),
            scopeSql(scope, {
              creator: creatorSql(
                ctx.tenantId,
                sql`${establishmentSchemeObjects.id}`,
                'establishment.scheme.create',
                'establishment-scheme',
              ),
            }),
          ),
        )
        .orderBy(
          establishmentSchemeVersions.schemeId,
          desc(establishmentSchemeVersions.startDate),
          desc(establishmentSchemeVersions.versionNo),
        )
        .limit(page.limit)
        .offset(page.offset);
      return loadSchemeBatch(
        tx,
        ctx.tenantId,
        selected.map((row) => row.id),
        asOf,
      );
    });
    return c.json({
      items: await trimModuleResponse(deps, ctx, OBJECT, items),
      hasDataPermission: scope.all || hasCreatorScope(scope),
    });
  });
  router.get(`${BASE}/schemes/:id`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT);
    const id = uuidParam(c);
    const asOf = queryDate(c, ctx);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    return c.json(
      await trimModuleResponse(
        deps,
        ctx,
        OBJECT,
        await withTenant(deps.db, ctx.tenantId, (tx) => visibleScheme(tx, ctx, scope, id, asOf)),
      ),
    );
  });
}

function registerSchemeWrites(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${BASE}/schemes`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'create', revision(c));
    const input = await parseBody(c, scheme);
    await writeFields(deps, ctx, OBJECT, 'create', input);
    visible(await requestScope(c, deps, ctx, OBJECT), undefined, '编制方案在该时点不存在', ctx.userId);
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, commandCtx) => ({
        status: 201,
        body: await createScheme(tx, commandCtx, input),
      }),
      OBJECT,
    );
  });
  router.patch(`${BASE}/schemes/:id`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const input = await parseBody(c, schemePatch);
    await writeFields(deps, ctx, OBJECT, 'update', input);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    await withTenant(deps.db, ctx.tenantId, (tx) => checkScheme(tx, ctx, scope, id));
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, commandCtx) => {
        await checkScheme(tx, ctx, scope, id);
        return { status: 200, body: await updateScheme(tx, commandCtx, id, input) };
      },
      OBJECT,
    );
  });
  router.delete(`${BASE}/schemes/:id`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'delete', revision(c));
    const id = uuidParam(c);
    await button(deps, ctx, OBJECT, 'delete', 'detail');
    const scope = await requestScope(c, deps, ctx, OBJECT);
    await withTenant(deps.db, ctx.tenantId, (tx) => checkScheme(tx, ctx, scope, id));
    return runWrite(
      c,
      deps,
      ctx,
      {},
      async (tx, commandCtx) => {
        await checkScheme(tx, ctx, scope, id);
        return { status: 200, body: await deleteScheme(tx, commandCtx, id) };
      },
      OBJECT,
    );
  });
}

function registerCapacities(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(`${BASE}/capacities`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT);
    const asOf = queryDate(c, ctx);
    const page = pageQuery(c);
    const orgId = queryUuid(c, 'orgId');
    const schemeId = queryUuid(c, 'schemeId');
    const periodStart = c.req.query('periodStart');
    if (periodStart && !validIsoDate(periodStart)) throw new AppError('VALIDATION_FAILED', '周期日期不合法');
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listCapacities(tx, ctx.tenantId, asOf, { orgId, schemeId, periodStart, scope }, page),
    );
    return c.json({
      items: await trimCapacities(deps, ctx, items),
      hasDataPermission: scope.hasDataPermission,
    });
  });
  router.get(`${BASE}/capacities/:id`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT);
    const id = uuidParam(c);
    const asOf = queryDate(c, ctx);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) => visibleCapacity(tx, ctx, scope, id, asOf));
    return c.json((await trimCapacities(deps, ctx, [result]))[0]);
  });
  router.post(`${BASE}/capacities`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'create', revision(c));
    const input = await parseBody(c, capacity);
    await writeFields(deps, ctx, OBJECT, 'create', input);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    visible(scope, input.orgId, '编制在该时点不存在', ctx.userId);
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, commandCtx) => ({
        status: 201,
        body: await createCapacity(tx, capacityContext(deps, commandCtx, scope), input),
      }),
      OBJECT,
    );
  });
  router.patch(`${BASE}/capacities/:id`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const input = await parseBody(c, capacityPatch);
    await writeFields(deps, ctx, OBJECT, 'update', input);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    await withTenant(deps.db, ctx.tenantId, (tx) => checkCapacity(tx, ctx, scope, id));
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, commandCtx) => {
        await checkCapacity(tx, ctx, scope, id);
        if (input.orgId) visible(scope, input.orgId, '编制在该时点不存在');
        return { status: 200, body: await updateCapacity(tx, capacityContext(deps, commandCtx, scope), id, input) };
      },
      OBJECT,
    );
  });
}

function registerTiming(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(`${BASE}/settings`, async (c) => {
    const ctx = await readContext(c, deps, 'admin.other_settings');
    const asOf = queryDate(c, ctx);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => readSettings(tx, ctx.tenantId, asOf)));
  });
  router.put(`${BASE}/settings`, async (c) => {
    const ctx = await readContext(c, deps, 'admin.other_settings', revision(c));
    const input = await parseBody(c, settings);
    return runWrite(c, deps, ctx, input, async (tx, commandCtx) => ({
      status: 200,
      body: await updateSettings(tx, commandCtx, input),
    }));
  });
}

function registerCopyJobs(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${BASE}/copy-jobs`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'create', revision(c));
    const input = await parseBody(c, z.strictObject({ capacityIds: z.array(z.uuid()).min(1).max(100) }));
    await writeFields(deps, ctx, OBJECT, 'create', input);
    await button(deps, ctx, OBJECT, 'copy', 'list');
    const scope = await requestScope(c, deps, ctx, OBJECT);
    await withTenant(deps.db, ctx.tenantId, async (tx) => {
      for (const id of input.capacityIds) await visibleCapacity(tx, ctx, scope, id, queryDate(c, ctx));
    });
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, commandCtx) => {
        for (const id of input.capacityIds) await visibleCapacity(tx, ctx, scope, id, queryDate(c, ctx));
        return { status: 202, body: await enqueueCopyJob(tx, commandCtx, input) };
      },
      OBJECT,
    );
  });
  router.get(`${BASE}/copy-jobs/:id`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT);
    const id = uuidParam(c);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const record = await withTenant(deps.db, ctx.tenantId, (tx) =>
      visibleCopyJob(tx, ctx, scope, id, queryDate(c, ctx)),
    );
    return c.json(await trimModuleResponse(deps, ctx, OBJECT, record));
  });
  router.post(`${BASE}/copy-jobs/:id/execute`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const input = await parseBody(c, z.strictObject({}));
    await writeFields(deps, ctx, OBJECT, 'update', input);
    await button(deps, ctx, OBJECT, 'execute', 'detail');
    const scope = await requestScope(c, deps, ctx, OBJECT);
    await withTenant(deps.db, ctx.tenantId, (tx) => visibleCopyJob(tx, ctx, scope, id, queryDate(c, ctx)));
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, commandCtx) => {
        await visibleCopyJob(tx, ctx, scope, id, queryDate(c, ctx));
        return { status: 200, body: await executeCopyJob(tx, capacityContext(deps, commandCtx, scope), id) };
      },
      OBJECT,
    );
  });
  router.get(`${BASE}/copy-jobs/:id/report`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT);
    const id = uuidParam(c);
    await button(deps, ctx, OBJECT, 'report', 'detail');
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const fields = await getModuleViewableFields(deps, ctx, OBJECT);
    const report = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      await visibleCopyJob(tx, ctx, scope, id, queryDate(c, ctx));
      return readCopyJobReport(tx, ctx, id, fields);
    });
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${report.filename}"`);
    return c.body(report.content);
  });
  router.get(`${BASE}/notifications`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT);
    const page = pageQuery(c);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listNotifications(tx, ctx.tenantId, ctx.userId, page, scope),
    );
    return c.json({
      items: await trimModuleResponse(deps, ctx, OBJECT, items),
      hasDataPermission: scope.hasDataPermission,
    });
  });
}

function queryUuid(c: Context, name: string): string | undefined {
  const value = c.req.query(name);
  if (value !== undefined && !isUuid(value)) throw new AppError('VALIDATION_FAILED', `${name} 必须为UUID`);
  return value;
}

async function visibleCapacity(tx: Tx, ctx: { tenantId: string }, scope: ModuleScope, id: string, asOf: string) {
  const record = await readCapacity(tx, ctx.tenantId, id, asOf);
  visible(
    scope,
    record.orgId,
    '编制在该时点不存在',
    hasCreatorScope(scope)
      ? await creatorOf(tx, ctx.tenantId, id, 'establishment.capacity.create', 'establishment-capacity')
      : undefined,
  );
  return record;
}

async function visibleCopyJob(tx: Tx, ctx: { tenantId: string }, scope: ModuleScope, id: string, asOf: string) {
  const record = await readCopyJob(tx, ctx.tenantId, id);
  for (const capacityId of record.capacityIds) {
    const capacity = await readCapacity(tx, ctx.tenantId, capacityId, asOf);
    visible(scope, capacity.orgId, '复制任务不存在', record.createdBy);
  }
  return record;
}

async function checkCapacity(tx: Tx, ctx: { tenantId: string }, scope: ModuleScope, id: string) {
  const [record] = await tx
    .select({ orgId: establishmentObjects.orgId })
    .from(establishmentObjects)
    .where(and(eq(establishmentObjects.tenantId, ctx.tenantId), eq(establishmentObjects.id, id)))
    .limit(1);
  if (!record) throw new AppError('NOT_FOUND', '编制在该时点不存在');
  visible(
    scope,
    record.orgId,
    '编制在该时点不存在',
    hasCreatorScope(scope)
      ? await creatorOf(tx, ctx.tenantId, id, 'establishment.capacity.create', 'establishment-capacity')
      : undefined,
  );
}

async function trimCapacities(deps: TenantRouteDeps, ctx: TenantContext, items: readonly CapacityRecord[]) {
  const fields = await getModuleViewableFields(deps, ctx, OBJECT);
  if (!fields) return items;
  const pick = (row: object) => Object.fromEntries(Object.entries(row).filter(([key]) => fields.has(key)));
  return items.map((item) => pick({ ...item, subdivisions: item.subdivisions.map(pick) }));
}

async function visibleScheme(tx: Tx, ctx: { tenantId: string }, scope: ModuleScope, id: string, asOf: string) {
  const creator = hasCreatorScope(scope)
    ? await creatorOf(tx, ctx.tenantId, id, 'establishment.scheme.create', 'establishment-scheme')
    : undefined;
  visible(scope, undefined, '编制方案在该时点不存在', creator);
  return loadScheme(tx, ctx.tenantId, id, asOf);
}

async function checkScheme(tx: Tx, ctx: { tenantId: string }, scope: ModuleScope, id: string) {
  const [record] = await tx
    .select({ id: establishmentSchemeObjects.id })
    .from(establishmentSchemeObjects)
    .where(and(eq(establishmentSchemeObjects.tenantId, ctx.tenantId), eq(establishmentSchemeObjects.id, id)))
    .limit(1);
  if (!record) throw new AppError('NOT_FOUND', '编制方案在该时点不存在');
  const creator = hasCreatorScope(scope)
    ? await creatorOf(tx, ctx.tenantId, id, 'establishment.scheme.create', 'establishment-scheme')
    : undefined;
  visible(scope, undefined, '编制方案在该时点不存在', creator);
}
