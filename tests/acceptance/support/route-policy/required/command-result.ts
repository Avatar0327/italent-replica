/** F-120 本人同租户；F-553（DEC-968）登记类型在当前事务执行条件授权和最小投影。 */
import type { Evidence, RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/command-result/routes.ts';
const SERVICE = 'apps/api/src/modules/command-result/service.ts';
const SOURCE = 'apps/api/src/modules/esign/source-command-result.ts';
const TASK = 'apps/api/src/modules/esign/source-result-access.ts';
const EMPLOYMENT = 'apps/api/src/modules/employment';
const DISPATCH: Evidence = {
  role: 'call',
  unit: `${SERVICE}#readOwnCommandResult`,
  anchor: 'return readRegisteredCommandResult(tx, deps, ctx, registration, entry.responseBody)',
};

export const COMMAND_RESULT: RequiredTable = {
  'GET /api/tenant/commands/:commandId/result': [
    {
      perm: 'own:command.result.initiator',
      at: [
        {
          role: 'call',
          unit: `${ROUTES}#route:GET /api/tenant/commands/:commandId/result`,
          anchor: 'withTenant(deps.db, ctx.tenantId, (tx) => readOwnCommandResult(tx, ctx, commandId, deps))',
        },
        { role: 'impl', unit: `${SERVICE}#readOwnCommandResult`, anchor: 'entry.actorUserId !== ctx.userId' },
        {
          role: 'impl',
          unit: `${SERVICE}#latestFailureGroup`,
          anchor: 'eq(f.actorUserId, ctx.userId)',
        },
      ],
    },
    {
      perm: 'guard:command.result.registered',
      facts: ['guard:command.result.registered'],
      note: '登记命令由当前成员、入口及来源范围、本人任务绑定和历史人员变量读权授权后才投影',
      at: [
        DISPATCH,
        {
          role: 'impl',
          unit: `${SERVICE}#commandResultRegistry`,
          anchor: 'createCommandResultRegistry(ESIGN_COMMAND_RESULTS)',
        },
        {
          role: 'impl',
          unit: `${SERVICE}#readRegisteredCommandResult`,
          anchor: 'await registration.authorize(tx, deps, ctx, body)',
        },
        {
          role: 'impl',
          unit: `${SERVICE}#readRegisteredCommandResult`,
          anchor: 'return registration.project(body)',
        },
        {
          role: 'impl',
          unit: `${SOURCE}#ESIGN_COMMAND_RESULTS`,
          anchor: 'isActiveAccount(tx, ctx.tenantId, ctx.userId)',
        },
        {
          role: 'impl',
          unit: `${SOURCE}#ESIGN_COMMAND_RESULTS`,
          anchor: 'await requireSource(tx, deps, ctx, sourceId)',
        },
        {
          role: 'impl',
          unit: `${TASK}#authorizeSourceSignTask`,
          anchor: "eq(scene === 'offer' ? esignTasks.offerId : esignTasks.businessId, sourceId)",
        },
        {
          role: 'impl',
          unit: `${TASK}#authorizeSourceSignTask`,
          anchor: 'eq(esignTasks.initiatorUserId, ctx.userId)',
        },
        {
          role: 'impl',
          unit: `${SOURCE}#projectSourceSignReceipt`,
          anchor: 'return { sourceId, taskId }',
        },
      ],
    },
    {
      perm: 'obj:TenantBase.Offer:update',
      purpose: 'when:command.result.registered',
      need: { scope: 'guard', guard: 'command.result.registered' },
      at: [
        DISPATCH,
        {
          role: 'const',
          unit: `${SOURCE}#OFFER_SIGN_COMMAND`,
          anchor: "'POST /api/tenant/offers/:id/esign-tasks'",
        },
        {
          role: 'call',
          unit: `${SOURCE}#requireOfferSignSource`,
          anchor: "requireObjectWrite(authorize, ctx, { objectCode: OFFER_OBJECT, operation: 'update', payload: {} })",
        },
        {
          role: 'scope',
          unit: `${SOURCE}#requireOfferSignSource`,
          anchor: 'scopeAllows(scope, { orgId: source.departmentId, creatorId: source.createdBy })',
        },
      ],
    },
    {
      perm: 'obj:TenantBase.EmploymentRecord:update',
      purpose: 'when:command.result.registered',
      need: { scope: 'guard', guard: 'command.result.registered' },
      at: [
        DISPATCH,
        {
          role: 'const',
          unit: `${SOURCE}#ENTRY_SIGN_COMMAND`,
          anchor: "'POST /api/tenant/employment/pending-entries/:id/esign-tasks'",
        },
        {
          role: 'call',
          unit: `${SOURCE}#requireEntrySignSource`,
          anchor: "requireEmploymentWrite(context, 'update', {}, 'Employment.Edit', undefined, { commandOnly: true })",
        },
        {
          role: 'scope',
          unit: `${EMPLOYMENT}/replay-guard.ts#requireBusinessWriteScope`,
          anchor: "ctx.transferTarget ? undefined : ctx.scope, 'write'",
        },
      ],
    },
    {
      perm: 'btn:TenantBase.EmploymentRecord#Employment.Edit@detail',
      purpose: 'when:command.result.registered',
      at: [
        DISPATCH,
        {
          role: 'call',
          unit: `${SOURCE}#requireEntrySignSource`,
          anchor: "await requireEmploymentWrite(context, 'update', {}, 'Employment.Edit'",
        },
        {
          role: 'impl',
          unit: `${EMPLOYMENT}/context.ts#requireEmploymentWrite`,
          anchor: 'resource: buttonResource(objectCode, button, definition.level)',
        },
      ],
    },
    {
      perm: 'obj:TenantBase.Employee:view',
      purpose: 'when:command.result.registered',
      need: { scope: 'guard', guard: 'command.result.registered' },
      note: '仅任务变量实际读取过人员字段时触发',
      at: [
        DISPATCH,
        {
          role: 'impl',
          unit: `${TASK}#authorizeSignVariables`,
          anchor: "action: 'object.view', resource: EMPLOYEE_OBJECT",
        },
        {
          role: 'scope',
          unit: `${TASK}#authorizeSignVariables`,
          anchor: 'await requireEmployeeInScope(tx, { ...ctx, scope }, employeeId)',
        },
        {
          role: 'impl',
          unit: `${TASK}#authorizeSignVariables`,
          anchor: 'if (viewable && fields.some((field) => !viewable.has(field))) throw forbidden()',
        },
      ],
    },
  ],
};
