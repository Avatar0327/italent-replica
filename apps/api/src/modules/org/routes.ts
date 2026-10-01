import { getTenant, isUuid, type Tx, withTenant } from '@italent/db';
import { ORG_DIMENSIONS, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { type TenantEnv, tenantOf } from '../../tenant-context.js';
import { releaseCode, reserveCode } from './codes.js';
import { importOrganizations } from './import-service.js';
import {
  displayOrganization,
  loadOrgSnapshot,
  orderOrganizations,
  type OrgRecord,
  validIsoDate,
} from './read-model.js';
import { readOrgSettings, writeOrgSettings } from './settings.js';
import { createOrganization, updateOrganization, validateOrganization, type OrgWriteContext } from './write-service.js';

const BASE = '/api/tenant/org';
const date = z.string().refine(validIsoDate, '日期必须为合法 YYYY-MM-DD');
const order = z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable().optional();
const parent = z.strictObject({ parentId: z.uuid(), sequence: order });
const parents = z.strictObject({
  admin: parent,
  business: parent.optional(),
  product: parent.optional(),
  reserve4: parent.optional(),
  reserve5: parent.optional(),
});
const fields = {
  name: z.string().trim().min(1).max(200),
  shortName: z.string().max(100).nullable().optional(),
  broadType: z.string().min(1).max(100).optional(),
  establishedOn: date.nullable().optional(),
  personInChargeId: z.uuid().nullable().optional(),
  hrbpId: z.uuid().nullable().optional(),
  costCenterId: z.uuid().nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  remarks: z.string().max(4000).nullable().optional(),
  displayOrder: order,
  isVirtual: z.boolean().optional(),
  stopDate: date.optional(),
  enabled: z.boolean().optional(),
  code: z.string().min(1).max(64).optional(),
};
const creation = z.strictObject({
  ...fields,
  parents,
  startDate: date.optional(),
  reservationId: z.uuid().optional(),
  confirmed: z.boolean().optional(),
});
const update = z
  .strictObject({ ...fields, parents: parents.partial().optional() })
  .partial()
  .extend({ effectiveDate: date });
const settings = z.strictObject({
  enabledDimensions: z.array(z.enum(ORG_DIMENSIONS)).max(5),
  fullNameStartLevel: z.number().int().min(0).max(9),
});
const importRow = z.strictObject({
  sourceCode: z.string().min(1).max(100),
  code: z.string().min(1).max(64),
  name: fields.name,
  parentId: z.uuid(),
  orgId: z.uuid().optional(),
  expectedRevision: z.number().int().min(0).optional(),
  startDate: date.optional(),
});

export function registerOrgRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerQueries(router, deps);
  registerReservations(router, deps);
  registerWrites(router, deps);
}

function registerQueries(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(`${BASE}/organizations`, async (c) => {
    const ctx = await context(c, deps, 'read');
    const asOf = queryDate(c, ctx);
    const dimension = z.enum(ORG_DIMENSIONS).safeParse(c.req.query('dimension') ?? 'admin');
    if (!dimension.success) throw new AppError('VALIDATION_FAILED', '组织维度不合法');
    const includeDisabled = c.req.query('includeDisabled') === 'true';
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const config = await readOrgSettings(tx, ctx.tenantId);
      if (!config.enabledDimensions.includes(dimension.data)) return [];
      return (await loadOrgSnapshot(tx, ctx.tenantId, asOf))
        .filter((org) => org.id !== ctx.tenantId && (includeDisabled || org.enabled))
        .filter((org) => dimension.data === 'admin' || !!org.parents[dimension.data])
        .filter((org) => c.req.query('name') === undefined || org.name === c.req.query('name'))
        .sort(orderOrganizations)
        .map((org) => displayOrganization(org, config.fullNameStartLevel));
    });
    return c.json({ items });
  });
  router.get(`${BASE}/organizations/:id`, async (c) => {
    const ctx = await context(c, deps, 'read');
    const id = orgId(c);
    const org = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const snapshot = await loadOrgSnapshot(tx, ctx.tenantId, queryDate(c, ctx));
      const record = snapshot.find((org) => org.id === id);
      if (!record) throw new AppError('NOT_FOUND', '组织不存在');
      return displayOrganization(record, (await readOrgSettings(tx, ctx.tenantId)).fullNameStartLevel);
    });
    c.header('ETag', `"${org.revision}"`);
    return c.json(org);
  });
  router.get(`${BASE}/settings`, async (c) => {
    const ctx = await context(c, deps, 'read');
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => readOrgSettings(tx, ctx.tenantId)));
  });
  router.get(`${BASE}/views`, async (c) => {
    await context(c, deps, 'read');
    return c.json({
      items: [
        { label: '组织', resource: 'organization', dimension: 'admin' },
        { label: '业务组织', resource: 'organization', dimension: 'business' },
        { label: '利润中心', resource: 'organization', dimension: 'product' },
        { label: '成本中心', resource: 'cost-center', dimension: null },
      ],
    });
  });
}

function registerReservations(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${BASE}/code-reservations`, async (c) => {
    const ctx = await context(c, deps, 'write', revision(c));
    requireNew(ctx);
    return write(c, deps, ctx, {}, async (tx, writeCtx) => ({ status: 201, body: await reserveCode(tx, writeCtx) }));
  });
  router.delete(`${BASE}/code-reservations/:id`, async (c) => {
    const ctx = await context(c, deps, 'write', revision(c));
    const id = orgId(c);
    return write(c, deps, ctx, {}, async (tx, writeCtx) => ({
      status: 200,
      body: await releaseCode(tx, writeCtx, id),
    }));
  });
}

function registerWrites(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${BASE}/validate`, async (c) => {
    const ctx = await context(c, deps, 'write');
    const input = await body(c, creation);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) => validateOrganization(tx, ctx, input));
    return c.json(result);
  });
  router.post(`${BASE}/organizations`, async (c) => {
    const ctx = await context(c, deps, 'write', revision(c));
    requireNew(ctx);
    const input = await body(c, creation);
    return write(c, deps, ctx, input, async (tx, writeCtx) => ({
      status: 201,
      body: await organizationResponse(tx, writeCtx, await createOrganization(tx, writeCtx, input)),
    }));
  });
  router.patch(`${BASE}/organizations/:id`, async (c) => {
    const ctx = await context(c, deps, 'write', revision(c));
    const id = orgId(c);
    const input = await body(c, update);
    return write(c, deps, ctx, input, async (tx, writeCtx) => ({
      status: 200,
      body: await organizationResponse(tx, writeCtx, await updateOrganization(tx, writeCtx, id, input)),
    }));
  });
  router.put(`${BASE}/settings`, async (c) => {
    const ctx = await context(c, deps, 'write', revision(c));
    const input = await body(c, settings);
    return write(c, deps, ctx, input, async (tx, writeCtx) => ({
      status: 200,
      body: await writeOrgSettings(tx, writeCtx, input),
    }));
  });
  router.post(`${BASE}/import`, async (c) => {
    const ctx = await context(c, deps, 'write', revision(c));
    requireNew(ctx);
    const input = await body(c, z.strictObject({ rows: z.array(importRow).min(1).max(100) }));
    return write(c, deps, ctx, input, async (tx, writeCtx) => ({
      status: 200,
      body: await importOrganizations(tx, writeCtx, input.rows),
    }));
  });
}

async function context(c: Context<TenantEnv>, deps: TenantRouteDeps, action: 'read' | 'write', expectedRevision = 0) {
  const ctx = tenantOf(c);
  await requirePermission(deps.authorize, { ...ctx, action: `tenant.org.${action}` });
  const tenant = await getTenant(deps.db, ctx.tenantId);
  if (!tenant) throw new AppError('TENANT_NOT_MEMBER', '不是该租户的成员');
  return { ...ctx, expectedRevision, rootName: tenant.name, now: deps.clock(), commandId: '' };
}

async function write(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: OrgWriteContext,
  input: unknown,
  execute: (tx: Tx, ctx: OrgWriteContext) => Promise<Awaited<ReturnType<typeof runCommand>>>,
) {
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input },
    execute: (tx, commandId) => execute(tx, { ...ctx, commandId }),
  });
  const payload = result.body as { revision?: number };
  if (payload.revision !== undefined) c.header('ETag', `"${payload.revision}"`);
  return c.json(result.body, result.status);
}

async function organizationResponse(tx: Tx, ctx: OrgWriteContext, org: OrgRecord) {
  return displayOrganization(org, (await readOrgSettings(tx, ctx.tenantId)).fullNameStartLevel);
}

async function body<T>(c: Context<TenantEnv>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '组织请求字段不合法', parsed.error.issues);
  return parsed.data;
}

function revision(c: Context): number {
  const match = /^(?:W\/)?"?(\d{1,9})"?$/.exec(c.req.header('if-match')?.trim() ?? '');
  if (!match) throw new AppError('REVISION_REQUIRED', '写请求必须在 If-Match 中携带 revision');
  return Number(match[1]);
}

function requireNew(ctx: OrgWriteContext): void {
  if (ctx.expectedRevision !== 0) throw new AppError('REVISION_CONFLICT', '新建操作的 revision 必须为 0');
}

function orgId(c: Context): string {
  const id = c.req.param('id') ?? '';
  if (!isUuid(id)) throw new AppError('VALIDATION_FAILED', '组织标识必须为 UUID');
  return id;
}

function queryDate(c: Context, ctx: OrgWriteContext): string {
  const asOf = c.req.query('asOf') ?? tenantLocalDate(ctx.now, ctx.timezone);
  if (!validIsoDate(asOf)) throw new AppError('VALIDATION_FAILED', '查询时点必须为合法日期');
  return asOf;
}
