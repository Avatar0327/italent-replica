/**
 * F-323（DEC-706）：设置 / 员工 / 人员类别（TenantBase.EmploymentType）。租户字典没有人员范围（noScope）：
 * 设置页读写按本对象的数据操作 + 按钮授权；员工表单下拉只列启用项，按任职查看权开放。
 * 写权限链放在 CommandGuard.before（#199），首次执行、幂等重放、失败回查都按当前权限复核。
 */
import { type Tx, withTenant } from '@italent/db';
import { buttonResource } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { requirePermission } from '../../authorization.js';
import type { CommandGuard, CommandResult } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { authorizeInTransaction, trimModuleResponse } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import {
  EMPLOYMENT_OBJECT,
  jsonBody,
  readContext,
  revision,
  runWrite,
  uuidParam,
  type EmploymentContext,
} from './context.js';
import {
  deleteEmploymentType,
  EMPLOYMENT_TYPE_OBJECT,
  listEmploymentTypes,
  parseEmploymentType,
  parseEmploymentTypeView,
  saveEmploymentType,
  setEmploymentTypeEnabled,
} from './employment-types.js';

interface TypeWrite {
  readonly operation: 'create' | 'update' | 'delete';
  readonly button: 'create' | 'update' | 'disable' | 'enable' | 'delete';
  readonly payload: Readonly<Record<string, unknown>>;
}

/** 写权限链（入口与命令内同一份）：对象数据操作 + 字段编辑权 → 按钮。 */
async function requireTypeWrite(tx: Tx, deps: TenantRouteDeps, ctx: EmploymentContext, write: TypeWrite) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  if (write.operation === 'delete')
    await requirePermission(authorize, { ...ctx, action: 'object.delete', resource: EMPLOYMENT_TYPE_OBJECT });
  else
    await requireObjectWrite(authorize, ctx, {
      objectCode: EMPLOYMENT_TYPE_OBJECT,
      operation: write.operation,
      payload: write.payload,
    });
  const level = write.button === 'create' ? 'list' : 'detail';
  await requirePermission(authorize, {
    ...ctx,
    action: 'object.button',
    resource: buttonResource(EMPLOYMENT_TYPE_OBJECT, write.button, level),
  });
}

async function runTypeWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  write: TypeWrite,
  input: unknown,
  execute: (tx: Tx, context: EmploymentContext) => Promise<CommandResult>,
) {
  const guard: CommandGuard = { before: (tx) => requireTypeWrite(tx, deps, ctx, write) };
  // 删除回执 { id, deleted } 是协议形状，不按对象字段裁剪
  const project = (body: unknown) =>
    (body as { deleted?: boolean }).deleted
      ? body
      : trimModuleResponse(deps, ctx, EMPLOYMENT_TYPE_OBJECT, body as object);
  return runWrite(c, deps, ctx, input, execute, { guard, project });
}

export function registerEmploymentTypeRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/employment-types', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0, undefined, EMPLOYMENT_TYPE_OBJECT);
    const view = parseEmploymentTypeView(c.req.query('view'));
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listEmploymentTypes(tx, ctx.tenantId, view));
    return c.json({ items: await trimModuleResponse(deps, ctx, EMPLOYMENT_TYPE_OBJECT, items) });
  });
  router.get('/employment-types/options', async (c) => {
    // 员工表单下拉：只给启用项的 ID / 名称 / 顺序号，按任职查看权开放（同用工形式字典）
    const ctx = tenantOf(c);
    await requirePermission(deps.authorize, { ...ctx, action: 'object.view', resource: EMPLOYMENT_OBJECT });
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listEmploymentTypes(tx, ctx.tenantId, 'enabled'));
    return c.json({ items: items.map(({ id, name, displayOrder }) => ({ id, name, displayOrder })) });
  });
  router.post('/employment-types', async (c) => {
    const ctx = await readContext(c, deps, 'object.create', revision(c), undefined, EMPLOYMENT_TYPE_OBJECT);
    const input = parseEmploymentType(await jsonBody(c));
    const write = { operation: 'create', button: 'create', payload: input } as const;
    return runTypeWrite(c, deps, ctx, write, input, async (tx, command) => ({
      status: 201,
      body: await saveEmploymentType(tx, command, input),
    }));
  });
  router.put('/employment-types/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c), undefined, EMPLOYMENT_TYPE_OBJECT);
    const input = parseEmploymentType(await jsonBody(c), true);
    const write = { operation: 'update', button: 'update', payload: input } as const;
    return runTypeWrite(c, deps, ctx, write, { id, input }, async (tx, command) => ({
      status: 200,
      body: await saveEmploymentType(tx, command, input, id),
    }));
  });
  router.post('/employment-types/:id/disable', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c), undefined, EMPLOYMENT_TYPE_OBJECT);
    const write = { operation: 'update', button: 'disable', payload: {} } as const;
    return runTypeWrite(c, deps, ctx, write, { id }, async (tx, command) => ({
      status: 200,
      body: await setEmploymentTypeEnabled(tx, command, id, false),
    }));
  });
  router.post('/employment-types/:id/enable', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c), undefined, EMPLOYMENT_TYPE_OBJECT);
    const write = { operation: 'update', button: 'enable', payload: {} } as const;
    return runTypeWrite(c, deps, ctx, write, { id }, async (tx, command) => ({
      status: 200,
      body: await setEmploymentTypeEnabled(tx, command, id, true),
    }));
  });
  router.delete('/employment-types/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.delete', revision(c), undefined, EMPLOYMENT_TYPE_OBJECT);
    const write = { operation: 'delete', button: 'delete', payload: {} } as const;
    return runTypeWrite(c, deps, ctx, write, { id }, async (tx, command) => ({
      status: 200,
      body: await deleteEmploymentType(tx, command, id),
    }));
  });
}
