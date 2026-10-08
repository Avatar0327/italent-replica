/**
 * R3-T07 PR-B 关键信息接口（docs/02_业务建模/28 IDP-R19～R22；PR 描述矩阵“带教 / 职业发展 / 轮岗”行）：
 * /api/tenant/idp/tutorships、/careers、/work-shifts 的列表 / 详情 / 新建 / 修改 / 删除。
 * 功能权限（对象 + 按钮 + 字段编辑权）在命令台账之前校验；范围按记录的员工（带教双方）与轮岗部门（K-35），范围外 404；
 * 首次与重放返回前按当前行复核范围；响应按对象字段权限裁剪。
 */
import { isUuid, type Tx, withTenant } from '@italent/db';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { pageQuery, parseBody, requireNew, revision, uuidParam } from '../job/context.js';
import {
  checkWriteFields,
  idpContext,
  type IdpContext,
  idpScope,
  idpWriteContext,
  type ModuleScope,
  listEnvelope,
  project,
  projectionOf,
} from './access.js';
import {
  createKeyInfo,
  deleteKeyInfo,
  inScope,
  KEY_INFO,
  type KeyInfoKind,
  type KeyInfoRow,
  listKeyInfo,
  loadKeyInfo,
  updateKeyInfo,
} from './key-info-service.js';
import { runIdpCommand } from './executor.js';
import { keyInfoColumn, keyInfoScopeSql } from './key-info-scope.js';
import * as input from './plan-input.js';

const BASE = '/api/tenant/idp';

const ROUTES: readonly {
  readonly path: string;
  readonly kind: KeyInfoKind;
  readonly create: z.ZodType<Record<string, unknown>>;
  readonly patch: z.ZodType<Record<string, unknown>>;
}[] = [
  { path: 'tutorships', kind: 'tutorship', create: input.tutorshipCreate, patch: input.tutorshipPatch },
  { path: 'careers', kind: 'career', create: input.careerCreate, patch: input.careerPatch },
  { path: 'work-shifts', kind: 'workShift', create: input.workShiftCreate, patch: input.workShiftPatch },
];

export function registerKeyInfoRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  for (const route of ROUTES) {
    registerReads(router, deps, route.path, route.kind);
    registerWrites(router, deps, route);
  }
}

function registerReads(router: Hono<TenantEnv>, deps: TenantRouteDeps, path: string, kind: KeyInfoKind) {
  const spec = KEY_INFO[kind];
  router.get(`${BASE}/${path}`, async (c) => {
    const ctx = await idpContext(c, deps, kind);
    const scope = await idpScope(c, deps, ctx, kind);
    const page = pageQuery(c);
    const employeeId = c.req.query('employeeId');
    if (employeeId !== undefined && !isUuid(employeeId)) {
      throw new AppError('VALIDATION_FAILED', 'employeeId 必须为 UUID');
    }
    const rows = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listKeyInfo(
        tx,
        ctx.tenantId,
        spec,
        keyInfoScopeSql(scope, spec, keyInfoColumn(spec)),
        page,
        employeeId?.toLowerCase(),
      ),
    );
    const fields = await projectionOf(deps, ctx, kind);
    return c.json({ ...listEnvelope(page, scope), items: rows.map((row) => project(row, fields)) });
  });

  router.get(`${BASE}/${path}/:id`, async (c) => {
    const ctx = await idpContext(c, deps, kind);
    const id = uuidParam(c);
    const scope = await idpScope(c, deps, ctx, kind);
    const row = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const found = await loadKeyInfo(tx, ctx.tenantId, spec, id);
      if (!found || !(await inScope(tx, scope, spec, found))) throw new AppError('NOT_FOUND', `${spec.label}不存在`);
      return found;
    });
    c.header('ETag', `"${row.revision}"`);
    return c.json(project(row, await projectionOf(deps, ctx, kind)));
  });
}

/**
 * 返回前（首次与重放，共用执行器 executor.ts）复核范围：删除按删除时的快照、其余按当前行（PR-A 同口径）；
 * 范围外 404。响应按当前字段权限裁剪。
 */
const stillInScope = (ctx: IdpContext, kind: KeyInfoKind, deleting: boolean) =>
  async function recheck(tx: Tx, scope: ModuleScope, view: KeyInfoRow) {
    const current = deleting ? view : await loadKeyInfo(tx, ctx.tenantId, KEY_INFO[kind], view.id);
    if (!current || !(await inScope(tx, scope, KEY_INFO[kind], current))) {
      throw new AppError('NOT_FOUND', `${KEY_INFO[kind].label}不存在`);
    }
  };

async function respondKeyInfo(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: IdpContext,
  kind: KeyInfoKind,
  result: { view: KeyInfoRow; status: number },
) {
  if (c.req.method !== 'DELETE') c.header('ETag', `"${result.view.revision}"`);
  return c.json(project(result.view, await projectionOf(deps, ctx, kind)), result.status as 200 | 201);
}

function registerWrites(router: Hono<TenantEnv>, deps: TenantRouteDeps, route: (typeof ROUTES)[number]) {
  const { path, kind } = route;
  const spec = KEY_INFO[kind];
  router.post(`${BASE}/${path}`, async (c) => {
    const ctx = await idpWriteContext(c, deps, kind, 'create', 'create', 'list', revision(c));
    requireNew(ctx);
    const body = await parseBody(c, route.create);
    await checkWriteFields(deps, ctx, kind, 'create', body);
    const result = await runIdpCommand(c, deps, ctx, {
      scope: await idpScope(c, deps, ctx, kind),
      status: 201,
      body,
      execute: (tx, w) => createKeyInfo(tx, w, spec, body),
      recheck: stillInScope(ctx, kind, false),
    });
    return respondKeyInfo(c, deps, ctx, kind, result);
  });
  router.patch(`${BASE}/${path}/:id`, async (c) => {
    const ctx = await idpWriteContext(c, deps, kind, 'update', 'update', 'detail', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, route.patch);
    await checkWriteFields(deps, ctx, kind, 'update', body);
    const result = await runIdpCommand(c, deps, ctx, {
      scope: await idpScope(c, deps, ctx, kind),
      status: 200,
      body: { id, body },
      execute: (tx, w) => updateKeyInfo(tx, w, spec, id, body),
      recheck: stillInScope(ctx, kind, false),
    });
    return respondKeyInfo(c, deps, ctx, kind, result);
  });
  router.delete(`${BASE}/${path}/:id`, async (c) => {
    const ctx = await idpWriteContext(c, deps, kind, 'delete', 'delete', 'detail', revision(c));
    const id = uuidParam(c);
    const result = await runIdpCommand(c, deps, ctx, {
      scope: await idpScope(c, deps, ctx, kind),
      status: 200,
      body: { id },
      execute: (tx, w) => deleteKeyInfo(tx, w, spec, id),
      recheck: stillInScope(ctx, kind, true),
    });
    return respondKeyInfo(c, deps, ctx, kind, result);
  });
}
