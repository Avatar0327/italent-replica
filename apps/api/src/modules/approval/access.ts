/**
 * 审批中心的功能权限：流程配置与管理员转交 / 干预受身份对象权限控制（DEC-080 真实字段与按钮）；
 * 管理员动作再按其数据范围限定到范围内员工的实例（数据范围默认为空，fail-closed）。
 * “我的待办 / 我发起的 / 通知”按接收人过滤，不需要身份权限。
 * TODO(需取证 Q-M0-42)：原站流程配置与“流程管理员”由哪类管理员身份持有未取证；首版按身份对象权限的按钮控制。
 */
import { sql, withTenant } from '@italent/db';
import {
  APPROVAL_INSTANCE_OBJECT,
  APPROVAL_OBJECTS,
  APPROVAL_PROCESS_OBJECT,
  buttonResource,
  MODULE_OBJECTS,
  PERSONNEL_REQUEST_OBJECT,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { requirePermission } from '../../authorization.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { registerObjectDefinition } from '../permission/catalog.js';
import { resolveModuleScope, scopeSql } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { approvalError, rowsOf } from './context.js';
import { loadInstance } from './store.js';

for (const object of APPROVAL_OBJECTS) registerObjectDefinition(object);

type ProcessButton =
  'create' | 'installPresets' | 'simulateByObject' | 'update' | 'newVersion' | 'publish' | 'discard' | 'simulate';

/**
 * DEC-102：流程配置权仅限租户级管理员——持有“流程矩阵”能力的企业管理员身份（租户管理员、系统管理员、矩阵管理员；
 * 矩阵管理员即专门的流程管理员）。与实例干预权（ApprovalInstance 按钮 + 数据范围）分开，部门级身份即使持有
 * 流程对象按钮也不能修改租户全局流程。TODO(需取证 Q-M0-42)：原站流程管理员身份的确切归属待核对。
 */
const PROCESS_ADMIN = 'admin.process_matrix';

export async function isProcessAdmin(deps: TenantRouteDeps, ctx: TenantContext): Promise<boolean> {
  return deps.authorize({ ...ctx, action: PROCESS_ADMIN });
}

/** 查看 / 仿真：流程管理员，或身份对象权限可查看流程。 */
export async function requireProcessView(deps: TenantRouteDeps, ctx: TenantContext): Promise<void> {
  if (await isProcessAdmin(deps, ctx)) return;
  await requirePermission(deps.authorize, { ...ctx, action: 'object.view', resource: APPROVAL_PROCESS_OBJECT });
}

export async function requireProcessButton(
  deps: TenantRouteDeps,
  ctx: TenantContext,
  button: ProcessButton,
): Promise<void> {
  if (button === 'simulate' || button === 'simulateByObject') {
    await requireProcessView(deps, ctx);
    return;
  }
  await requirePermission(deps.authorize, { ...ctx, action: PROCESS_ADMIN });
}

async function hasButton(deps: TenantRouteDeps, ctx: TenantContext, button: string, level: 'list' | 'detail') {
  return deps.authorize({
    ...ctx,
    action: 'object.button',
    resource: buttonResource(APPROVAL_INSTANCE_OBJECT, button, level),
  });
}

/**
 * 审批侧撤回时复核发起人当前权限（PR #35 第二轮 C-非5）：任职申请须仍持有任职撤回按钮与编辑权，
 * 且异动员工仍在其数据范围内；员工子集变更须仍可使用自助申请入口。发起人身份在命令内校验。
 */
export async function requireWithdrawRight(deps: TenantRouteDeps, ctx: TenantContext, instanceId: string) {
  const instance = await withTenant(deps.db, ctx.tenantId, (tx) => loadInstance(tx, ctx.tenantId, instanceId));
  if (instance.businessType === 'personnel_change') {
    await requirePermission(deps.authorize, {
      ...ctx,
      action: 'object.button',
      resource: buttonResource(PERSONNEL_REQUEST_OBJECT, 'self-service-submit', 'list'),
    });
    return;
  }
  const objectCode = MODULE_OBJECTS.employmentRecord.code;
  await requireObjectWrite(deps.authorize, ctx, { objectCode, operation: 'update', payload: {} });
  await requirePermission(deps.authorize, {
    ...ctx,
    action: 'object.button',
    resource: buttonResource(objectCode, 'Employment.Withdraw', 'detail'),
  });
  const scope = await resolveModuleScope(deps, ctx, undefined, objectCode, `${objectCode}.list`);
  const predicate = scopeSql(scope, { person: sql`i.subject_employee_id` });
  const [covered] = rowsOf(
    await withTenant(deps.db, ctx.tenantId, (tx) =>
      tx.execute(sql`SELECT 1 FROM approval_instances i WHERE i.tenant_id=${ctx.tenantId}
        AND i.id=${instanceId}::uuid AND ${predicate}`),
    ),
  );
  if (!covered) throw approvalError('FORBIDDEN', 'APPROVAL_SCOPE_DENIED', '异动员工已不在您的数据范围内');
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
