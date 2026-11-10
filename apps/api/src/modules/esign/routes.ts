/**
 * 调动电子签署配置路由（F-481 设计 §3.2、§5.4、§10；S1 契约片）。对象 TenantBase.ESignSettings（配置对象，无数据范围）。
 * - GET/POST /templates、PATCH /templates/:id：签署模板库（没有删除，停用即从下拉消失）；
 * - GET/PUT /scenes/transfer：调动签署场景设置（有效期 2～30 天、到期前提醒）；
 * - GET /template-options/transfer-form：调动表单“电子签模板”下拉，授权同发起调动（Transfer.Hr 按钮），不要求模板维护权。
 * 写入口都走命令台账（runCommand），守卫在命令事务内按当前权限复核；revision 经 If-Match 携带（AGENTS.md §10）。
 */
import { withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { requirePermission } from '../../authorization.js';
import { runCommand, type CommandGuard } from '../../commands.js';
import type { BodyLimitOverride } from '../../middleware.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { parseBody, revision, uuidParam } from '../job/context.js';
import { authorizeInTransaction, getModuleViewableFields } from '../permission/module-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { button, objectContext, writeFields } from '../permission/module-route-access.js';
import { createTemplateSchema, patchTemplateSchema, sceneSettingsSchema } from './input.js';
import {
  assertKnownVariables,
  createTemplate,
  getSceneSettings,
  listTemplates,
  patchTemplate,
  saveSceneSettings,
  templateOptions,
} from './service.js';

export const ESIGN_BASE = '/api/tenant/esign';
/**
 * 模板正文 ≤20000 字（UTF-16 单元），中文按 3 字节、JSON 控制字符转义最多 6 字节，最坏约 120KB，
 * 加编码 / 名称（各 ≤100 字）与键名约 1.5KB；放宽到 128KB，仍是有界上限。只对模板新建 / 编辑生效，
 * 场景设置等其余接口仍为默认 32KB。
 */
export const ESIGN_TEMPLATE_BODY_LIMIT = 128 * 1024;
export const ESIGN_BODY_LIMITS: readonly BodyLimitOverride[] = [
  { method: 'POST', path: /^\/api\/tenant\/esign\/templates$/, maxSize: ESIGN_TEMPLATE_BODY_LIMIT },
  { method: 'PATCH', path: /^\/api\/tenant\/esign\/templates\/[^/]+$/, maxSize: ESIGN_TEMPLATE_BODY_LIMIT },
];
const OBJECT = MODULE_OBJECTS.eSignSettings.code;
const TRANSFER_HR_BUTTON = 'Transfer.Hr';
type C = Context<TenantEnv>;

/** 按配置对象的查看字段裁剪响应；id / revision / scene 是对象标识与并发控制，不属于可隐藏字段。 */
async function trim<T>(deps: TenantRouteDeps, c: C, value: T): Promise<T> {
  const fields = await getModuleViewableFields(deps, tenantOf(c), OBJECT);
  if (fields === undefined) return value;
  const keep = (key: string) => ['id', 'revision', 'scene', 'items'].includes(key) || fields.has(key);
  const project = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(project)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item).flatMap(([key, v]) => (keep(key) ? [[key, key === 'items' ? project(v) : v]] : [])),
          )
        : item;
  return project(value) as T;
}

/** 写命令：事务内先按当前权限复核（对象 update/create + 逐字段编辑权），再执行；重放同样经 before。 */
async function write(
  c: C,
  deps: TenantRouteDeps,
  ctx: ScopeBusinessContext,
  operation: 'create' | 'update',
  payload: Record<string, unknown>,
  execute: Parameters<typeof runCommand>[2]['execute'],
) {
  const guard: CommandGuard = {
    before: async (tx) => {
      await requirePermission(authorizeInTransaction(deps.authorize, tx), {
        ...ctx,
        action: `object.${operation}`,
        resource: OBJECT,
        fields: Object.keys(payload),
      });
    },
  };
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, payload },
    guard,
    execute,
  });
  return c.json(await trim(deps, c, result.body), result.status);
}

export function registerESignRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${ESIGN_BASE}/templates`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'view');
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listTemplates(tx, ctx.tenantId));
    return c.json(await trim(deps, c, { items }));
  });

  router.post(`${ESIGN_BASE}/templates`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'create');
    const input = await parseBody(c, createTemplateSchema);
    assertKnownVariables(input.body);
    await writeFields(deps, ctx, OBJECT, 'create', input);
    return write(c, deps, ctx, 'create', input, async (tx, commandId) => ({
      status: 201,
      body: await createTemplate(tx, { ...ctx, commandId }, input),
    }));
  });

  router.patch(`${ESIGN_BASE}/templates/:id`, async (c) => {
    const base = await objectContext(c, deps, OBJECT, 'update');
    const id = uuidParam(c);
    const ctx = { ...base, expectedRevision: revision(c) };
    const input = await parseBody(c, patchTemplateSchema);
    if (input.body !== undefined) assertKnownVariables(input.body);
    await writeFields(deps, ctx, OBJECT, 'update', input);
    return write(c, deps, ctx, 'update', input, async (tx, commandId) => ({
      status: 200,
      body: await patchTemplate(tx, { ...ctx, commandId }, id, input),
    }));
  });

  router.get(`${ESIGN_BASE}/scenes/transfer`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'view');
    const settings = await withTenant(deps.db, ctx.tenantId, (tx) => getSceneSettings(tx, ctx.tenantId));
    return c.json(await trim(deps, c, settings));
  });

  router.put(`${ESIGN_BASE}/scenes/transfer`, async (c) => {
    const base = await objectContext(c, deps, OBJECT, 'update');
    const ctx = { ...base, expectedRevision: revision(c) };
    const input = await parseBody(c, sceneSettingsSchema);
    await writeFields(deps, ctx, OBJECT, 'update', input);
    return write(c, deps, ctx, 'update', input, async (tx, commandId) => ({
      status: 200,
      body: await saveSceneSettings(tx, { ...ctx, commandId }, input),
    }));
  });

  // 授权与 POST /transfers/employees/:id 的 HR 入口同一：任职对象新增权 + Transfer.Hr 按钮（detail）
  router.get(`${ESIGN_BASE}/template-options/transfer-form`, async (c) => {
    const ctx = await objectContext(c, deps, EMPLOYMENT_OBJECT, 'create');
    await button(deps, ctx, EMPLOYMENT_OBJECT, TRANSFER_HR_BUTTON, 'detail');
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => templateOptions(tx, ctx.tenantId)));
  });
}
