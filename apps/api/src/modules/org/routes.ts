import { authorizeOrgResult, originalOrgImportRows } from '../permission/org-result-scope.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { getTenant, isUuid, type Tx, withTenant } from '@italent/db';
import { MODULE_OBJECTS, ORG_DIMENSIONS, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import {
  button,
  creatorOf,
  hasCreatorScope,
  objectContext,
  requestScope,
  resolveModuleScope,
  trimModuleResponse,
  visible,
  writeFields,
} from '../permission/module-route-access.js';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { type TenantEnv, tenantOf } from '../../tenant-context.js';
import { listOrgPersonCandidates } from '../employment/org-people.js';
import { pageQuery } from '../job/context.js';
import { releaseCode, reserveCode } from './codes.js';
import { authorizeOrgImportRows, importOrganizations, type OrgImportRow } from './import-service.js';
import { displayOrganization, loadOrgSnapshot, type OrgRecord, validIsoDate } from './read-model.js';
import { readOrgSettings, writeOrgSettings } from './settings.js';
import { ORG_PERSON_FIELDS } from './validation.js';
import {
  correctEstablishedOn,
  createOrganization,
  updateOrganization,
  validateOrganization,
  type OrgWriteContext,
} from './write-service.js';
import { withFailedImportLog } from '../../audit/record.js';

const BASE = '/api/tenant/org';
const OBJECT = MODULE_OBJECTS.organization.code;
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
  shopOwnerId: z.uuid().nullable().optional(),
  costCenterId: z.uuid().nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  remarks: z.string().max(4000).nullable().optional(),
  displayOrder: order,
  isVirtual: z.boolean().optional(),
  stopDate: date.optional(),
  enabled: z.boolean().optional(),
  code: z.string().min(1).max(64).optional(),
};
// DEC-130：新建不再单独收生效日期（startDate），首个版本自设立日期 establishedOn 起生效。
const creation = z.strictObject({
  ...fields,
  parents,
  reservationId: z.uuid().optional(),
  confirmed: z.boolean().optional(),
});
const update = z
  .strictObject({ ...fields, parents: parents.partial().optional() })
  .partial()
  .extend({ effectiveDate: date });
// DEC-147：「编辑」（更正、不产生新版本）目前只开放设立日期，首版生效日随之变化。
const correction = z.strictObject({ establishedOn: date });
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
  registerPersonCandidates(router, deps);
  registerReservations(router, deps);
  registerWrites(router, deps);
  registerCorrection(router, deps);
  registerOrgImport(router, deps);
}

function registerQueries(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(`${BASE}/organizations`, async (c) => {
    const ctx = await context(c, deps, 'read');
    const asOf = queryDate(c, ctx);
    const dimension = z.enum(ORG_DIMENSIONS).safeParse(c.req.query('dimension') ?? 'admin');
    if (!dimension.success) throw new AppError('VALIDATION_FAILED', '组织维度不合法');
    const includeDisabled = c.req.query('includeDisabled') === 'true';
    const page = queryInteger(c, 'page', 1, 1, 1_000_000);
    const pageSize = queryInteger(c, 'pageSize', 50, 1, 200);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const config = await readOrgSettings(tx, ctx.tenantId);
      if (!config.enabledDimensions.includes(dimension.data)) return [];
      return (
        await loadOrgSnapshot(
          tx,
          ctx.tenantId,
          asOf,
          { limit: pageSize, offset: (page - 1) * pageSize },
          {
            scope,
            includeDisabled,
            dimension: dimension.data,
            name: c.req.query('name'),
          },
        )
      ).map((org) => displayOrganization(org, config.fullNameStartLevel));
    });
    return c.json({
      items: await trimModuleResponse(deps, ctx, OBJECT, items),
      hasDataPermission: scope.hasDataPermission,
    });
  });
  router.get(`${BASE}/organizations/:id`, async (c) => {
    const ctx = await context(c, deps, 'read');
    const id = orgId(c);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const org = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      visible(
        scope,
        id,
        '组织不存在',
        hasCreatorScope(scope) ? await creatorOf(tx, ctx.tenantId, id, 'org.create', 'organization') : undefined,
      );
      const snapshot = await loadOrgSnapshot(tx, ctx.tenantId, queryDate(c, ctx), undefined, { id });
      const record = snapshot.find((org) => org.id === id);
      if (!record) throw new AppError('NOT_FOUND', '组织不存在');
      return displayOrganization(record, (await readOrgSettings(tx, ctx.tenantId)).fullNameStartLevel);
    });
    c.header('ETag', `"${org.revision}"`);
    return c.json(await trimModuleResponse(deps, ctx, OBJECT, org));
  });
  router.get(`${BASE}/settings`, async (c) => {
    const ctx = await context(c, deps, 'configuration');
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => readOrgSettings(tx, ctx.tenantId)));
  });
  router.get(`${BASE}/views`, async (c) => {
    const ctx = await context(c, deps, 'read');
    // TODO(需取证 Q-M0-09): 界面任务接入四视图目录；本车道不含 apps/web。
    return c.json({
      items: await trimModuleResponse(deps, ctx, OBJECT, [
        { label: '组织', resource: 'organization', dimension: 'admin' },
        { label: '业务组织', resource: 'organization', dimension: 'business' },
        { label: '利润中心', resource: 'organization', dimension: 'product' },
        { label: '成本中心', resource: 'cost-center', dimension: null },
      ]),
    });
  });
}

/**
 * DEC-135（`10` §14）：负责人 / HRBP / 店长的人员选择器——全租户生效日在职的内部员工，不按操作人数据范围过滤；
 * 只返回姓名、工号、部门（DEC-057 最少字段）。只有能填写这三个字段之一的人（组织新增或编辑权限 + 字段编辑权）可用。
 */
function registerPersonCandidates(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(`${BASE}/person-candidates`, async (c) => {
    const ctx = tenantOf(c);
    const allowed = await anyPersonFieldEditable(deps, ctx);
    if (!allowed) throw new AppError('FORBIDDEN', '无权填写组织负责人、HRBP 或店长');
    const now = deps.clock();
    const asOf = c.req.query('asOf') ?? tenantLocalDate(now, ctx.timezone);
    if (!validIsoDate(asOf)) throw new AppError('VALIDATION_FAILED', '查询时点必须为合法日期');
    const keyword = c.req.query('keyword');
    if (keyword !== undefined && keyword.length > 100) throw new AppError('VALIDATION_FAILED', '关键字过长');
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listOrgPersonCandidates(tx, { tenantId: ctx.tenantId, asOf, keyword, limit: page.limit, offset: page.offset }),
    );
    return c.json({ items, page: page.page, pageSize: page.pageSize });
  });
}

async function anyPersonFieldEditable(deps: TenantRouteDeps, ctx: ReturnType<typeof tenantOf>): Promise<boolean> {
  for (const operation of ['create', 'update'] as const) {
    for (const field of ORG_PERSON_FIELDS) {
      const request = { ...ctx, action: `object.${operation}`, resource: OBJECT, fields: [field] };
      if (await deps.authorize(request)) return true;
    }
  }
  return false;
}

function queryInteger(c: Context, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AppError('VALIDATION_FAILED', `${name} 不合法`);
  }
  return parsed;
}

function registerReservations(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${BASE}/code-reservations`, async (c) => {
    const ctx = await context(c, deps, 'create', revision(c));
    requireNew(ctx);
    await body(c, z.strictObject({}));
    await button(deps, ctx, OBJECT, 'reserve', 'list');
    await writeFields(deps, ctx, OBJECT, 'create', {});
    visible(await requestScope(c, deps, ctx, OBJECT), undefined);
    return write(c, deps, ctx, {}, async (tx, writeCtx) => ({ status: 201, body: await reserveCode(tx, writeCtx) }));
  });
  router.delete(`${BASE}/code-reservations/:id`, async (c) => {
    const ctx = await context(c, deps, 'delete', revision(c));
    const id = orgId(c);
    await button(deps, ctx, OBJECT, 'release', 'detail');
    visible(await requestScope(c, deps, ctx, OBJECT), undefined);
    return write(c, deps, ctx, {}, async (tx, writeCtx) => ({
      status: 200,
      body: await releaseCode(tx, writeCtx, id),
    }));
  });
}

/** DEC-147：「编辑」（更正、不产生新版本）改设立日期，首版生效日随之变化；权限与范围同「变更」。 */
function registerCorrection(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.patch(`${BASE}/organizations/:id/correction`, async (c) => {
    const ctx = await context(c, deps, 'update', revision(c));
    const id = orgId(c);
    const input = await body(c, correction);
    await writeFields(deps, ctx, OBJECT, 'update', input);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    await withTenant(deps.db, ctx.tenantId, async (tx) =>
      visible(
        scope,
        id,
        '组织不存在',
        hasCreatorScope(scope) ? await creatorOf(tx, ctx.tenantId, id, 'org.create', 'organization') : undefined,
      ),
    );
    return write(
      c,
      deps,
      ctx,
      input,
      async (tx, writeCtx) => ({
        status: 200,
        body: await organizationResponse(
          tx,
          writeCtx,
          await correctEstablishedOn(tx, writeCtx, id, input.establishedOn),
        ),
      }),
      true,
      scope,
    );
  });
}

function registerWrites(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${BASE}/validate`, async (c) => {
    const ctx = await context(c, deps, 'create');
    const input = await body(c, creation);
    await writeFields(deps, ctx, OBJECT, 'create', input);
    await button(deps, ctx, OBJECT, 'validate', 'detail');
    const scope = await requestScope(c, deps, ctx, OBJECT);
    await visibleParents(deps, ctx, input.parents, scope);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) => validateOrganization(tx, ctx, input));
    return c.json(await trimModuleResponse(deps, ctx, OBJECT, result));
  });
  router.post(`${BASE}/organizations`, async (c) => {
    const ctx = await context(c, deps, 'create', revision(c));
    requireNew(ctx);
    const input = await body(c, creation);
    await writeFields(deps, ctx, OBJECT, 'create', input);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    await visibleParents(deps, ctx, input.parents, scope);
    return write(
      c,
      deps,
      ctx,
      input,
      async (tx, writeCtx) => ({
        status: 201,
        body: await organizationResponse(tx, writeCtx, await createOrganization(tx, writeCtx, input)),
      }),
      true,
      scope,
    );
  });
  router.patch(`${BASE}/organizations/:id`, async (c) => {
    const ctx = await context(c, deps, 'update', revision(c));
    const id = orgId(c);
    const input = await body(c, update);
    await writeFields(deps, ctx, OBJECT, 'update', input);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    await withTenant(deps.db, ctx.tenantId, async (tx) =>
      visible(
        scope,
        id,
        '组织不存在',
        hasCreatorScope(scope) ? await creatorOf(tx, ctx.tenantId, id, 'org.create', 'organization') : undefined,
      ),
    );
    if (input.parents) await visibleParents(deps, ctx, input.parents, scope);
    return write(
      c,
      deps,
      ctx,
      input,
      async (tx, writeCtx) => {
        // DEC-129：级联停用的每个下级都须在操作人当前数据范围内；范围外按不存在处理，不列名称。
        const authorizeCascade = async (cascadeTx: Tx, ids: readonly string[]) => {
          for (const descendant of ids) await authorizeOrgResult(cascadeTx, ctx, scope, descendant, false);
        };
        const saved = await updateOrganization(tx, writeCtx, id, input, { authorizeCascade });
        return { status: 200, body: await organizationResponse(tx, writeCtx, saved) };
      },
      true,
      scope,
    );
  });
  router.put(`${BASE}/settings`, async (c) => {
    const ctx = await context(c, deps, 'configuration', revision(c));
    const input = await body(c, settings);
    return write(
      c,
      deps,
      ctx,
      input,
      async (tx, writeCtx) => ({
        status: 200,
        body: await writeOrgSettings(tx, writeCtx, input),
      }),
      false,
    );
  });
}

function registerOrgImport(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.post(`${BASE}/import`, async (c) => {
    const ctx = await context(c, deps, 'read', revision(c));
    requireNew(ctx);
    const input = await body(c, z.strictObject({ rows: z.array(importRow).min(1).max(100) }));
    await button(deps, ctx, OBJECT, 'import', 'list');
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const originalRows = await withTenant(deps.db, ctx.tenantId, (tx) =>
      originalOrgImportRows(tx, ctx.tenantId, c.req.header('idempotency-key') ?? ''),
    );
    const guard = async (tx: Tx, row: OrgImportRow, targetId: string | undefined) => {
      const replayCreated =
        !!targetId &&
        originalRows.some(
          (original) =>
            original.orgId === targetId && original.sourceCode === row.sourceCode && original.status === 'created',
        );
      const { orgId: _id, expectedRevision: _revision, ...payload } = row;
      await writeFields(
        { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) },
        ctx,
        OBJECT,
        targetId && !replayCreated ? 'update' : 'create',
        payload,
      );
      visible(
        scope,
        row.parentId,
        '组织不存在',
        hasCreatorScope(scope)
          ? await creatorOf(tx, ctx.tenantId, row.parentId, 'org.create', 'organization')
          : undefined,
      );
      if (targetId) await authorizeOrgResult(tx, ctx, scope, targetId, replayCreated);
    };
    await withTenant(deps.db, ctx.tenantId, (tx) =>
      authorizeOrgImportRows(tx, ctx, input.rows, (row, target) => guard(tx, row, target)),
    );
    // DEC-199：整批失败也留任务级日志
    const task = { ...ctx, commandId: c.req.header('idempotency-key'), objectType: 'organization' };
    return withFailedImportLog(deps.db, { ...task, total: input.rows.length }, () =>
      write(
        c,
        deps,
        ctx,
        input,
        async (tx, writeCtx) => ({
          status: 200,
          body: await importOrganizations(tx, writeCtx, input.rows, (row, target) => guard(tx, row, target)),
        }),
        true,
        scope,
      ),
    );
  });
}

async function context(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  action: 'read' | 'create' | 'update' | 'delete' | 'configuration',
  expectedRevision = 0,
) {
  const ctx = tenantOf(c);
  if (action === 'configuration') await requirePermission(deps.authorize, { ...ctx, action: 'admin.other_settings' });
  else await objectContext(c, deps, OBJECT, action === 'read' ? 'view' : action, expectedRevision);
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
  trim = true,
  resolvedScope?: Awaited<ReturnType<typeof resolveModuleScope>>,
) {
  const checksOrgResult = trim && (c.req.path.includes('/organizations') || c.req.path.endsWith('/import'));
  const scope = checksOrgResult
    ? (resolvedScope ?? (await resolveModuleScope(deps, ctx, undefined, OBJECT)))
    : undefined;
  const checkResult = async (tx: Tx, value: Record<string, unknown>, status: number) => {
    if (!scope) return;
    if (Array.isArray(value.results)) {
      for (const row of value.results as { orgId?: string; status: string }[]) {
        if (row.orgId) await authorizeOrgResult(tx, ctx, scope, row.orgId, row.status === 'created');
      }
    } else if (typeof value.id === 'string') await authorizeOrgResult(tx, ctx, scope, value.id, status === 201);
  };
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input },
    execute: async (tx, commandId) => {
      const commandResult = await execute(tx, { ...ctx, commandId });
      await checkResult(tx, commandResult.body as Record<string, unknown>, commandResult.status);
      return commandResult;
    },
  });
  const payload = result.body as { revision?: number };
  if (payload.revision !== undefined) c.header('ETag', `"${payload.revision}"`);
  const value = result.body as Record<string, unknown>;
  if (checksOrgResult) await withTenant(deps.db, ctx.tenantId, (tx) => checkResult(tx, value, result.status));
  const output = !trim
    ? value
    : Array.isArray(value.results)
      ? { results: await trimModuleResponse(deps, ctx, OBJECT, value.results) }
      : await trimModuleResponse(deps, ctx, OBJECT, value);
  return c.json(output, result.status);
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

async function visibleParents(
  deps: TenantRouteDeps,
  ctx: OrgWriteContext,
  parents: Record<string, { parentId: string } | undefined>,
  scope: Awaited<ReturnType<typeof resolveModuleScope>>,
) {
  await withTenant(deps.db, ctx.tenantId, async (tx) => {
    for (const parent of Object.values(parents))
      if (parent)
        visible(
          scope,
          parent.parentId,
          '组织不存在',
          hasCreatorScope(scope)
            ? await creatorOf(tx, ctx.tenantId, parent.parentId, 'org.create', 'organization')
            : undefined,
        );
  });
}
