import { CONTRACT_OBJECT, contractAction } from '@italent/domain';
import { loadRequest, requestWriteFields, mergeFields } from '../contracts/service.js';
import { checkFields, checkScope } from '../contracts/context.js';
/**
 * 审批中心的功能权限：流程配置仅限租户级管理员（DEC-102）；管理员转交 / 干预受身份对象权限控制（DEC-080 真实字段与按钮），
 * 再按其数据范围限定到范围内员工的实例（数据范围默认为空，fail-closed）。
 * “我的待办 / 我发起的 / 通知”按接收人过滤，不需要身份权限。
 */
import { sql, type Tx, withTenant } from '@italent/db';
import {
  APPROVAL_INSTANCE_OBJECT,
  APPROVAL_OBJECTS,
  APPROVAL_PROCESS_OBJECT,
  buttonResource,
  mayResubmit,
  MODULE_OBJECTS,
  PERSONNEL_REQUEST_OBJECT,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { requirePermission } from '../../authorization.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { employmentCreator } from '../employment/context.js';
import { registerObjectDefinition } from '../permission/catalog.js';
import {
  resolveModuleScope,
  resolveModuleScopeInTransaction,
  scopeSql,
  type ModuleScope,
} from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { approvalError, rowsOf } from './context.js';
import { personOfUser } from './resolver.js';
import { loadInstance } from './store.js';

for (const object of APPROVAL_OBJECTS) registerObjectDefinition(object);

type ProcessButton =
  'create' | 'installPresets' | 'simulateByObject' | 'update' | 'newVersion' | 'publish' | 'discard' | 'simulate';

/**
 * DEC-102：流程配置权仅限租户级管理员——持有“流程矩阵”能力的企业管理员身份（租户管理员、系统管理员、矩阵管理员；
 * 矩阵管理员即专门的流程管理员）。与实例干预权（ApprovalInstance 按钮 + 数据范围）分开，部门级身份即使持有
 * 流程对象按钮也不能修改租户全局流程。原站取证与此一致（`14` §11.5，Q-M0-42）。
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
 * 实例的数据范围谓词（对 approval_instances 别名 i）：人员维度取异动员工；“使用用户”维度取任职业务的真实创建人
 * （与任职模块的范围判断一致，F10）。员工子集变更没有任职创建人，“使用用户”维度对其不成立（默认拒绝）。
 */
export function instanceScopeSql(ctx: TenantContext, scope: ModuleScope): SQL {
  return scopeSql(scope, {
    person: sql`i.subject_employee_id`,
    creator: sql`CASE WHEN i.business_type='employment'
      THEN ${employmentCreator(ctx.tenantId, sql`i.business_id`, true)}
      WHEN i.business_type='contract' THEN (SELECT created_by FROM contract_requests c
        WHERE c.tenant_id=i.tenant_id AND c.id=i.business_id) END`,
  });
}

async function requireSelfServiceSubmit(deps: TenantRouteDeps, ctx: TenantContext) {
  await requirePermission(deps.authorize, {
    ...ctx,
    action: 'object.button',
    resource: buttonResource(PERSONNEL_REQUEST_OBJECT, 'self-service-submit', 'list'),
  });
}

/**
 * 审批侧撤回时复核发起人当前权限（PR #35 第二轮 C-非5）：任职申请须仍持有任职撤回按钮与编辑权，
 * 且该业务仍在其数据范围内（含“创建人 = 本人”，F10）；员工子集变更须仍可使用自助申请入口。发起人身份在命令内校验。
 */
export async function requireWithdrawRight(deps: TenantRouteDeps, ctx: TenantContext, instanceId: string) {
  const instance = await withTenant(deps.db, ctx.tenantId, (tx) => loadInstance(tx, ctx.tenantId, instanceId));
  if (instance.businessType === 'personnel_change') {
    await requireSelfServiceSubmit(deps, ctx);
    return;
  }
  const objectCode = instance.businessType === 'contract' ? CONTRACT_OBJECT : MODULE_OBJECTS.employmentRecord.code;
  await requireObjectWrite(deps.authorize, ctx, { objectCode, operation: 'update', payload: {} });
  await requirePermission(deps.authorize, {
    ...ctx,
    action: 'object.button',
    resource: buttonResource(
      objectCode,
      instance.businessType === 'contract' ? 'withdraw' : 'Employment.Withdraw',
      'detail',
    ),
  });
  const scope = await resolveModuleScope(deps, ctx, undefined, objectCode, `${objectCode}.list`);
  const predicate = instanceScopeSql(ctx, scope);
  const [covered] = rowsOf(
    await withTenant(deps.db, ctx.tenantId, (tx) =>
      tx.execute(sql`SELECT 1 FROM approval_instances i WHERE i.tenant_id=${ctx.tenantId}
        AND i.id=${instanceId}::uuid AND ${predicate}`),
    ),
  );
  if (!covered) throw approvalError('FORBIDDEN', 'APPROVAL_SCOPE_DENIED', '该申请已不在您的数据范围内');
}

/**
 * DEC-113 / F3：重提只由原发起人进行，并按首次提交复核其当前权限——员工子集变更须仍持有自助申请按钮，且账号仍绑定
 * 异动本人（自助申请的范围就是本人）。任职申请经任职模块的“提交”重提，那里按任职权限校验，审批侧命令直接拒绝。
 */
export async function requireResubmitRight(
  deps: TenantRouteDeps,
  ctx: TenantContext,
  instanceId: string,
  corrections: Readonly<Record<string, unknown>> = {},
) {
  const { instance, person } = await withTenant(deps.db, ctx.tenantId, async (tx) => ({
    instance: await loadInstance(tx, ctx.tenantId, instanceId),
    person: await personOfUser(tx, ctx.tenantId, ctx.userId),
  }));
  if (!mayResubmit(instance.initiatorUserId, ctx.userId)) {
    throw approvalError('FORBIDDEN', 'APPROVAL_NOT_INITIATOR', '只有原发起人可以重新提交');
  }
  if (instance.businessType === 'contract') {
    const scope = await resolveModuleScope(deps, ctx, undefined, CONTRACT_OBJECT, `${CONTRACT_OBJECT}.list`);
    await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const request = await loadRequest(tx, ctx.tenantId, instance.businessId);
      await requirePermission(deps.authorize, {
        ...ctx,
        action: 'object.button',
        resource: buttonResource(
          CONTRACT_OBJECT,
          contractAction(request.operation, request.mode),
          request.operation === 'create' ? 'list' : 'detail',
        ),
      });
      const context = {
        ...ctx,
        scope,
        authorize: deps.authorize,
        now: deps.clock(),
        commandId: '',
        expectedRevision: 0,
      };
      await checkScope(tx, context, request.employeeId, request.createdBy);
      await checkFields(
        context,
        request.operation === 'create' ? 'create' : 'update',
        mergeFields(requestWriteFields(request), corrections),
      );
    });
  }
  if (instance.businessType !== 'personnel_change') return;
  await requireSelfServiceSubmit(deps, ctx);
  if (!person || person !== instance.subjectEmployeeId) {
    throw approvalError('FORBIDDEN', 'APPROVAL_NOT_SELF', '账号已不再绑定该员工，不能重新提交本人申请');
  }
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
  const contractScope = await resolveModuleScope(deps, ctx, undefined, CONTRACT_OBJECT, `${CONTRACT_OBJECT}.list`);
  return sql`((i.business_type='contract' AND ${instanceScopeSql(ctx, contractScope)})
    OR (i.business_type<>'contract' AND ${instanceScopeSql(ctx, scope)}))`;
}

/**
 * DEC-123：某成员（替代人）的数据范围对实例的谓词，在调用方事务内解析（成员停用的平台事务内使用）。
 * 与管理员范围同一对象与页面（任职记录列表），但不要求管理员按钮——这是系统自动接管，不是该成员的操作。
 */
export async function memberInstanceScope(deps: TenantRouteDeps, ctx: TenantContext, tx: Tx): Promise<SQL> {
  const objectCode = MODULE_OBJECTS.employmentRecord.code;
  const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, objectCode, `${objectCode}.list`);
  const contractScope = await resolveModuleScopeInTransaction(
    deps,
    ctx,
    tx,
    CONTRACT_OBJECT,
    `${CONTRACT_OBJECT}.list`,
  );
  return sql`((i.business_type='contract' AND ${instanceScopeSql(ctx, contractScope)})
    OR (i.business_type<>'contract' AND ${instanceScopeSql(ctx, scope)}))`;
}
