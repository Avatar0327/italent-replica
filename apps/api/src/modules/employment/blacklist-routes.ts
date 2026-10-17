/**
 * R2 BE-8a 黑名单与离职自动加黑规则路由（挂在任职子应用 policedSub 上，策略登记在 employment/policy.ts）。
 * - 黑名单（TenantBase.Blacklist）：没有组织字段，数据范围只认看全部；读按对象查看权 + 看全部，证件号 / 手机 / 邮箱按字段查看权
 *   裁剪；写按对象数据操作 + 按钮 + 字段编辑权，选人员加黑另须该员工在操作人的任职数据范围内（快照的是档案敏感字段）。
 *   写入口的权限链放在 CommandGuard.before（#199）：首次执行、幂等重放、失败回查都在命令事务内按当前权限复核。
 * - 规则：任职设置配置对象（tenant.employment.configuration.write，管理员 other_settings）。
 * - 总开关：两层配置 exit.auto_blacklist_enabled，经既有 /api/tenant/settings/:key 读写，这里只登记取值校验。
 */
import { type Tx, withTenant } from '@italent/db';
import {
  AUTO_BLACKLIST_SETTING_KEY,
  buttonResource,
  isAutoBlacklistSettingValue,
  MODULE_OBJECTS,
} from '@italent/domain';
import type { Context, Hono } from 'hono';
import { requirePermission } from '../../authorization.js';
import { type CommandGuard, runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  resolveModuleScopeInTransaction,
  trimModuleResponse,
} from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import {
  addBlacklistEntry,
  BLACKLIST_FILTER_FIELDS,
  BLACKLIST_OBJECT,
  deleteBlacklistEntries,
  listBlacklist,
  parseBlacklistBatch,
  parseBlacklistCreate,
  parseBlacklistFilter,
  parseBlacklistUpdate,
  removeBlacklistEntries,
  updateBlacklistEntry,
} from './blacklist.js';
import { deleteBlacklistRule, listBlacklistRules, parseBlacklistRule, saveBlacklistRule } from './blacklist-rules.js';
import {
  EMPLOYMENT_OBJECT,
  jsonBody,
  pageQuery,
  readContext,
  requireEmployeeInScope,
  requireEmploymentWrite,
  revision,
  runWrite,
  uuidParam,
  type EmploymentContext,
} from './context.js';

registerSettingValidator(AUTO_BLACKLIST_SETTING_KEY, isAutoBlacklistSettingValue);

const SETTINGS = MODULE_OBJECTS.employmentSettings.code;

interface BlacklistWrite {
  readonly operation: 'create' | 'update' | 'delete';
  readonly button: 'create' | 'update' | 'remove' | 'delete';
  readonly payload: Readonly<Record<string, unknown>>;
  /** 选人员加黑：该员工须在操作人的任职数据范围内（范围外与不存在同一个 404）。 */
  readonly employeeId?: string;
}

/**
 * 黑名单写权限链（入口与命令内同一份，#199）：对象数据操作 + 字段编辑权 → 按钮 → 看全部（新增无看全部 403，按记录操作 404）
 * → 选人员时的任职数据范围。
 */
async function requireBlacklistWrite(tx: Tx, deps: TenantRouteDeps, ctx: EmploymentContext, write: BlacklistWrite) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  if (write.operation === 'delete')
    await requirePermission(authorize, { ...ctx, action: 'object.delete', resource: BLACKLIST_OBJECT });
  else
    await requireObjectWrite(authorize, ctx, {
      objectCode: BLACKLIST_OBJECT,
      operation: write.operation,
      payload: write.payload,
    });
  const level = write.button === 'update' ? 'list_row' : 'list';
  await requirePermission(authorize, {
    ...ctx,
    action: 'object.button',
    resource: buttonResource(BLACKLIST_OBJECT, write.button, level),
  });
  const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, BLACKLIST_OBJECT);
  if (!scope.all) {
    if (write.operation === 'create') throw new AppError('FORBIDDEN', '黑名单只对有“看全部”数据权限的人员开放');
    throw new AppError('NOT_FOUND', '黑名单记录不存在');
  }
  if (write.employeeId) {
    const employment = await resolveModuleScopeInTransaction(deps, ctx, tx, EMPLOYMENT_OBJECT);
    // 范围外与不存在（personSnapshot 的 404）同一文案，不暴露员工是否存在
    await requireEmployeeInScope(tx, { ...ctx, scope: employment }, write.employeeId).catch((error: unknown) => {
      throw error instanceof AppError && error.code === 'NOT_FOUND' ? new AppError('NOT_FOUND', '员工不存在') : error;
    });
  }
}

const blacklistGuard = (deps: TenantRouteDeps, ctx: EmploymentContext, write: BlacklistWrite): CommandGuard => ({
  before: (tx) => requireBlacklistWrite(tx, deps, ctx, write),
});

/** 黑名单写入的命令执行：台账 + 命令内复核（guard），返回前按操作人当前字段查看权裁剪。 */
async function runBlacklistWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  write: BlacklistWrite,
  input: unknown,
  execute: (tx: Tx, context: EmploymentContext) => Promise<unknown>,
  status: 200 | 201 = 200,
) {
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input },
    guard: blacklistGuard(deps, ctx, write),
    execute: async (tx, commandId) => ({
      status,
      body: await execute(tx, { ...ctx, commandId, authorize: authorizeInTransaction(deps.authorize, tx) }),
    }),
  });
  return c.json(await trimBlacklist(deps, ctx, result.body), result.status);
}

/** 单条记录、{ items } 列表 / 回执、{ deleted } 回执三种形状；记录按黑名单对象字段查看权平铺裁剪。 */
async function trimBlacklist(deps: TenantRouteDeps, ctx: EmploymentContext, body: unknown): Promise<unknown> {
  const value = body as Record<string, unknown>;
  if (typeof value.deleted === 'number') return { deleted: value.deleted };
  if (Array.isArray(value.items))
    return { ...value, items: await trimModuleResponse(deps, ctx, BLACKLIST_OBJECT, value.items as object[]) };
  return trimModuleResponse(deps, ctx, BLACKLIST_OBJECT, value);
}

export function registerBlacklistRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/blacklist', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0, undefined, BLACKLIST_OBJECT);
    const { page: _page, pageSize: _size, ...query } = c.req.query();
    const filter = parseBlacklistFilter(query);
    const page = pageQuery(c);
    const used = BLACKLIST_FILTER_FIELDS.filter((field) => filter[field] !== undefined);
    const viewable = await getModuleViewableFields(deps, ctx, BLACKLIST_OBJECT);
    if (viewable && used.some((field) => !viewable.has(field))) throw new AppError('FORBIDDEN', '筛选字段不可查看');
    const all = ctx.scope?.all === true;
    const items = all
      ? await withTenant(deps.db, ctx.tenantId, (tx) => listBlacklist(tx, ctx.tenantId, filter, page))
      : [];
    return c.json({
      items: await trimModuleResponse(deps, ctx, BLACKLIST_OBJECT, items),
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: all,
    });
  });
  router.post('/blacklist', async (c) => {
    const ctx = await readContext(c, deps, 'object.create', revision(c), undefined, BLACKLIST_OBJECT);
    const input = parseBlacklistCreate(await jsonBody(c));
    const write = { operation: 'create', button: 'create', payload: input, employeeId: input.employeeId } as const;
    return runBlacklistWrite(c, deps, ctx, write, input, (tx, context) => addBlacklistEntry(tx, context, input), 201);
  });
  router.put('/blacklist/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c), undefined, BLACKLIST_OBJECT);
    const input = parseBlacklistUpdate(await jsonBody(c));
    const write = { operation: 'update', button: 'update', payload: input } as const;
    return runBlacklistWrite(c, deps, ctx, write, { id, input }, (tx, context) =>
      updateBlacklistEntry(tx, context, id, input),
    );
  });
  // 移出 / 删除：工具栏多选与行内单条共用，body { items: [{ id, revision }] }（逐条 revision，不用 If-Match）
  router.post('/blacklist/remove', async (c) => {
    const ctx = await readContext(c, deps, 'object.update', 0, undefined, BLACKLIST_OBJECT);
    const input = parseBlacklistBatch(await jsonBody(c));
    const write = { operation: 'update', button: 'remove', payload: {} } as const;
    return runBlacklistWrite(c, deps, ctx, write, input, (tx, context) => removeBlacklistEntries(tx, context, input));
  });
  router.post('/blacklist/delete', async (c) => {
    const ctx = await readContext(c, deps, 'object.delete', 0, undefined, BLACKLIST_OBJECT);
    const input = parseBlacklistBatch(await jsonBody(c));
    const write = { operation: 'delete', button: 'delete', payload: {} } as const;
    return runBlacklistWrite(c, deps, ctx, write, input, (tx, context) => deleteBlacklistEntries(tx, context, input));
  });
  registerBlacklistRuleRoutes(router, deps);
}

/** 规则写入的命令内复核：配置写别名（other_settings）与配置对象字段编辑权，同入口。 */
function ruleGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  payload: Readonly<Record<string, unknown>>,
): CommandGuard {
  return {
    before: async (tx) => {
      const authorize = authorizeInTransaction(deps.authorize, tx);
      await requirePermission(authorize, {
        ...ctx,
        action: 'tenant.employment.configuration.write',
        resource: SETTINGS,
      });
      await requireObjectWrite(authorize, ctx, { objectCode: SETTINGS, operation: 'update', payload });
    },
  };
}

function registerBlacklistRuleRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const configuration = (c: Context<TenantEnv>) =>
    readContext(
      c,
      deps,
      'tenant.employment.configuration.write',
      revision(c),
      undefined,
      'TenantBase.EmploymentSettings',
    );
  router.get('/blacklist-rules', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings');
    const rules = await withTenant(deps.db, ctx.tenantId, (tx) => listBlacklistRules(tx, ctx.tenantId));
    return c.json({ items: await trimModuleResponse(deps, ctx, SETTINGS, rules) });
  });
  router.post('/blacklist-rules', async (c) => {
    const ctx = await configuration(c);
    const input = parseBlacklistRule(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, context) => ({ status: 201, body: await saveBlacklistRule(tx, context, input) }),
      { guard: ruleGuard(deps, ctx, input) },
    );
  });
  router.put('/blacklist-rules/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await configuration(c);
    const input = parseBlacklistRule(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      { id, input },
      async (tx, context) => ({ status: 200, body: await saveBlacklistRule(tx, context, input, id) }),
      { guard: ruleGuard(deps, ctx, input) },
    );
  });
  // 配置对象没有“删除”数据操作（授权器 CONFIG_OBJECTS 只判 view / create / update），删除沿用 update，同合同续签规则
  router.delete('/blacklist-rules/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await configuration(c);
    await requireEmploymentWrite(ctx, 'update', {}, undefined, 'TenantBase.EmploymentSettings', {
      commandOnly: true,
    });
    return runWrite(
      c,
      deps,
      ctx,
      { id },
      async (tx, context) => ({ status: 200, body: await deleteBlacklistRule(tx, context, id) }),
      { guard: ruleGuard(deps, ctx, {}), project: (body) => body },
    );
  });
}
