import { authorizeJobResult } from '../permission/job-result-scope.js';
import { registerJobScopeReader } from '../permission/module-contracts.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { withTenant, type Tx } from '@italent/db';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { MODULE_OBJECTS } from '@italent/domain';
import {
  button,
  hasCreatorScope,
  resolveModuleScope,
  JOB_OBJECT_CODES,
  objectContext,
  requestScope,
  trimModuleResponse,
  visible,
  visibleJob,
  writeFields,
  type ModuleScope,
} from '../permission/module-route-access.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import {
  type BusinessContext,
  pageQuery,
  parseBody,
  queryDate,
  readContext,
  requireNew,
  revision,
  runWrite,
  uuidParam,
} from './context.js';
import { businessDate, jobCreationSchema, jobPatchSchema } from './fields.js';
import { authorizeJobImportRows, importJobObjects, type JobImportRow } from './import-service.js';
import { JOB_KINDS, type JobKind } from './metadata.js';
import { jobCandidates, latestJobObject, listJobObjects, loadJobObject } from './read-model.js';
import { jobSettingsCommandSchema, readJobSettings, writeJobSettings } from './settings.js';
import type { JobInput, JobPatch } from './types.js';
import { validateJobAssignment } from './validation.js';
import { createJobObject, updateJobObject } from './write-service.js';

const BASE = '/api/tenant/job';
registerJobScopeReader({ load: loadJobObject, latest: latestJobObject });
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
  registerObjectWrites(router, deps);
}

function registerSettings(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${BASE}/settings`, async (c) => {
    const ctx = await readContext(c, deps, 'admin.other_settings');
    const asOf = queryDate(c, ctx);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) => readJobSettings(tx, ctx.tenantId, asOf));
    c.header('ETag', `"${result.revision}"`);
    return c.json(result);
  });
  router.put(`${BASE}/settings`, async (c) => {
    const ctx = await readContext(c, deps, 'admin.other_settings', revision(c));
    // 先命中命令台账再按新规则校验：升级前已成功的旧命令可重放首次结果（DEC-133）。
    const input = await parseBody(c, jobSettingsCommandSchema);
    return runWrite(c, deps, ctx, input, async (tx, writeCtx) => ({
      status: 200,
      body: await writeJobSettings(tx, writeCtx, input),
    }));
  });
}

function registerCandidates(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  for (const kind of ['levels', 'grades'] as const) {
    router.get(`${BASE}/candidates/${kind}`, async (c) => {
      const objectCode = JOB_OBJECT_CODES[kind];
      const ctx = await objectContext(c, deps, objectCode);
      const postId = z.uuid().safeParse(c.req.query('postId'));
      const levelId = z.uuid().optional().safeParse(c.req.query('levelId'));
      if (!postId.success || !levelId.success) throw new AppError('VALIDATION_FAILED', '职务或职级 ID 不合法');
      const page = pageQuery(c);
      const input = { postId: postId.data, levelId: levelId.data, asOf: queryDate(c, ctx), ...page };
      const scope = await requestScope(c, deps, ctx, objectCode);
      const references = await assignmentReferences(c, deps, input);
      const items =
        !scope.all && !hasCreatorScope(scope)
          ? []
          : await withTenant(deps.db, ctx.tenantId, async (tx) => {
              await references(tx);
              return jobCandidates(tx, ctx.tenantId, { ...input, scope }, kind);
            });
      return c.json({
        items: await trimModuleResponse(deps, ctx, objectCode, items),
        page: page.page,
        pageSize: page.pageSize,
        hasDataPermission: scope.all || hasCreatorScope(scope),
      });
    });
  }
  router.post(`${BASE}/validate-assignment`, async (c) => {
    const objectCode = MODULE_OBJECTS.jobPost.code;
    const ctx = await objectContext(c, deps, objectCode);
    const input = await parseBody(c, assignment);
    await button(deps, ctx, objectCode, 'validate', 'detail');
    const references = await assignmentReferences(c, deps, input);
    const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      await references(tx);
      return validateJobAssignment(tx, ctx.tenantId, input);
    });
    return c.json(result);
  });
}

/** 显式引用逐对象授权，不能用候选/职务自身的看全部来放行另一个对象。 */
async function assignmentReferences(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  input: { postId: string; levelId?: string; gradeId?: string; asOf: string },
) {
  const references: { kind: JobKind; id: string; ctx: BusinessContext; scope: ModuleScope }[] = [];
  for (const [kind, id] of [
    ['posts', input.postId],
    ['levels', input.levelId],
    ['grades', input.gradeId],
  ] as const) {
    if (!id) continue;
    const code = JOB_OBJECT_CODES[kind];
    const ctx = await objectContext(c, deps, code);
    const scope = await resolveModuleScope(
      deps,
      ctx,
      undefined,
      code,
      c.req.method === 'GET' ? `${code}.detail` : undefined,
    );
    references.push({ kind, id, ctx, scope });
  }
  return async (tx: Tx) => {
    for (const { kind, id, ctx, scope } of references) {
      if (!scope.all) await visibleJob(tx, ctx, scope, kind, id, input.asOf);
    }
  };
}

function registerImport(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(`${BASE}/import`, async (c) => {
    const ctx = { ...tenantOf(c), expectedRevision: revision(c), commandId: '', now: deps.clock() };
    requireNew(ctx);
    const input = await parseBody(
      c,
      z.strictObject({
        kind: z.enum(JOB_KINDS),
        rows: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
      }),
    );
    const objectCode = JOB_OBJECT_CODES[input.kind];
    await objectContext(c, deps, objectCode);
    await button(deps, ctx, objectCode, 'import', 'list');
    const scope = await requestScope(c, deps, ctx, objectCode);
    const row = jobCreationSchema(input.kind).extend({
      sourceCode: z.string().trim().min(1).max(100),
      objectId: z.uuid().optional(),
      expectedRevision: z.number().int().min(1).optional(),
    });
    const parsed = z.array(row).safeParse(input.rows);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '导入行字段不合法', parsed.error.issues);
    const guard = async (tx: Tx, row: JobImportRow, targetId: string | undefined) => {
      const { objectId: _id, expectedRevision: _revision, ...payload } = row;
      await writeFields(
        { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) },
        ctx,
        objectCode,
        targetId ? 'update' : 'create',
        payload,
      );
      visible(
        scope,
        input.kind === 'positions' ? (row.orgId as string) : undefined,
        '职务体系对象不存在或已失效',
        input.kind === 'positions' ? undefined : ctx.userId,
      );
      if (targetId && !scope.all)
        await visibleJob(tx, ctx, scope, input.kind, targetId, row.startDate ?? queryDate(c, ctx));
    };
    const rows = parsed.data as JobImportRow[];
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, writeCtx) => ({
        status: 200,
        body: await importJobObjects(tx, writeCtx, input.kind, rows, (row, target) => guard(tx, row, target)),
      }),
      objectCode,
      (tx) => authorizeJobImportRows(tx, ctx, input.kind, rows, (row, target) => guard(tx, row, target)),
      (tx, body) => authorizeJobResult(tx, ctx, scope, input.kind, body),
    );
  });
}

function registerObjects(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${BASE}/:kind`, async (c) => {
    const kind = objectKind(c);
    const objectCode = JOB_OBJECT_CODES[kind];
    const ctx = await objectContext(c, deps, objectCode);
    const page = pageQuery(c);
    const orgId = z.uuid().optional().safeParse(c.req.query('orgId'));
    if (!orgId.success) throw new AppError('VALIDATION_FAILED', '组织 ID 不合法');
    const enabled = enabledFilter(c);
    const scope = await requestScope(c, deps, ctx, objectCode);
    const query = { asOf: queryDate(c, ctx), name: c.req.query('name'), orgId: orgId.data, enabled, scope, ...page };
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listJobObjects(tx, ctx.tenantId, kind, query));
    return c.json({
      items: await trimModuleResponse(deps, ctx, objectCode, items),
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: kind === 'positions' ? scope.hasDataPermission : scope.all || hasCreatorScope(scope),
    });
  });
  router.get(`${BASE}/:kind/:id`, async (c) => {
    const kind = objectKind(c);
    const objectCode = JOB_OBJECT_CODES[kind];
    const ctx = await objectContext(c, deps, objectCode);
    const id = uuidParam(c);
    const asOf = queryDate(c, ctx);
    const scope = await requestScope(c, deps, ctx, objectCode);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) => visibleJob(tx, ctx, scope, kind, id, asOf));
    if (!result) throw new AppError('NOT_FOUND', '职务体系对象不存在或已失效');
    c.header('ETag', `"${result.revision}"`);
    return c.json(await trimModuleResponse(deps, ctx, objectCode, result));
  });
}

function registerObjectWrites(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(`${BASE}/:kind`, async (c) => {
    const kind = objectKind(c);
    const objectCode = JOB_OBJECT_CODES[kind];
    const ctx = await objectContext(c, deps, objectCode, 'create', revision(c));
    requireNew(ctx);
    const input = await parseBody(c, jobCreationSchema(kind));
    await writeFields(deps, ctx, objectCode, 'create', input);
    const scope = await requestScope(c, deps, ctx, objectCode);
    visible(scope, (input as JobInput).orgId as string | undefined, '职务体系对象不存在或已失效');
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, writeCtx) => ({
        status: 201,
        body: await createJobObject(tx, writeCtx, kind, input as JobInput),
      }),
      objectCode,
      undefined,
      (tx, body) => authorizeJobResult(tx, ctx, scope, kind, body),
    );
  });
  router.patch(`${BASE}/:kind/:id`, async (c) => {
    const kind = objectKind(c);
    const objectCode = JOB_OBJECT_CODES[kind];
    const ctx = await objectContext(c, deps, objectCode, 'update', revision(c));
    const id = uuidParam(c);
    const input = await parseBody(c, jobPatchSchema(kind));
    // 「调整员工直线经理」是本次变更的选项而非职位字段；同步任职由人员端口在事务内另行验权。
    const { adjustEmployeeDirectManager: _option, ...fields } = input as JobPatch;
    await writeFields(deps, ctx, objectCode, 'update', fields);
    const scope = await requestScope(c, deps, ctx, objectCode);
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, writeCtx) => {
        if (!scope.all) await visibleJob(tx, ctx, scope, kind, id, input.effectiveDate);
        if ((input as JobPatch).orgId)
          visible(scope, (input as JobPatch).orgId as string, '职务体系对象不存在或已失效');
        return { status: 200, body: await updateJobObject(tx, writeCtx, kind, id, input as JobPatch) };
      },
      objectCode,
      async (tx) => {
        if (!scope.all) await visibleJob(tx, ctx, scope, kind, id, input.effectiveDate);
        if ((input as JobPatch).orgId)
          visible(scope, (input as JobPatch).orgId as string, '职务体系对象不存在或已失效');
      },
      (tx, body) => authorizeJobResult(tx, ctx, scope, kind, body),
    );
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
