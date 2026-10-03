/**
 * 审批中心的功能权限：流程配置与管理员转交 / 干预受身份对象权限控制（DEC-080 真实字段与按钮）；
 * 管理员动作再按其数据范围限定到范围内员工的实例（数据范围默认为空，fail-closed）。
 * “我的待办 / 我发起的 / 通知”按接收人过滤，不需要身份权限。
 * TODO(需取证 Q-M0-42)：原站流程配置与“流程管理员”由哪类管理员身份持有未取证；首版按身份对象权限的按钮控制。
 */
import { sql } from '@italent/db';
import {
  APPROVAL_INSTANCE_OBJECT,
  APPROVAL_OBJECTS,
  APPROVAL_PROCESS_OBJECT,
  buttonResource,
  MODULE_OBJECTS,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { requirePermission } from '../../authorization.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { registerObjectDefinition } from '../permission/catalog.js';
import { resolveModuleScope, scopeSql } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';

for (const object of APPROVAL_OBJECTS) registerObjectDefinition(object);

type ProcessButton =
  'create' | 'installPresets' | 'simulateByObject' | 'update' | 'newVersion' | 'publish' | 'discard' | 'simulate';
const LIST_BUTTONS = new Set<ProcessButton>(['create', 'installPresets', 'simulateByObject']);

export async function requireProcessView(deps: TenantRouteDeps, ctx: TenantContext): Promise<void> {
  await requirePermission(deps.authorize, { ...ctx, action: 'object.view', resource: APPROVAL_PROCESS_OBJECT });
}

export async function requireProcessButton(
  deps: TenantRouteDeps,
  ctx: TenantContext,
  button: ProcessButton,
  payload?: Record<string, unknown>,
): Promise<void> {
  if (button === 'create' || button === 'update') {
    await requireObjectWrite(deps.authorize, ctx, {
      objectCode: APPROVAL_PROCESS_OBJECT,
      operation: button,
      payload: payload ?? {},
    });
  } else if (['simulate', 'simulateByObject'].includes(button)) await requireProcessView(deps, ctx);
  else
    await requirePermission(deps.authorize, {
      ...ctx,
      action: button === 'installPresets' ? 'object.create' : 'object.update',
      resource: APPROVAL_PROCESS_OBJECT,
      fields: [],
    });
  await requirePermission(deps.authorize, {
    ...ctx,
    action: 'object.button',
    resource: buttonResource(APPROVAL_PROCESS_OBJECT, button, LIST_BUTTONS.has(button) ? 'list' : 'detail'),
  });
}

async function hasButton(deps: TenantRouteDeps, ctx: TenantContext, button: string, level: 'list' | 'detail') {
  return deps.authorize({
    ...ctx,
    action: 'object.button',
    resource: buttonResource(APPROVAL_INSTANCE_OBJECT, button, level),
  });
}

/** 管理员按钮 + 员工数据范围；返回限定实例的 SQL 谓词（对 approval_instances 别名 i）。 */
export async function adminScope(
  deps: TenantRouteDeps,
  ctx: TenantContext,
  buttons: readonly ('adminTransfer' | 'adminIntervene' | 'adminLogs')[],
): Promise<SQL | null> {
  let allowed = false;
  for (const button of buttons)
    allowed ||= await hasButton(deps, ctx, button, button === 'adminLogs' ? 'list' : 'detail');
  if (!allowed) return null;
  const objectCode = MODULE_OBJECTS.employmentRecord.code;
  const scope = await resolveModuleScope(deps, ctx, undefined, objectCode, `${objectCode}.list`);
  return scopeSql(scope, { person: sql`i.subject_employee_id` });
}
