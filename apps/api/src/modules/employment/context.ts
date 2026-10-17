import { sql, withTenant, type Tx } from '@italent/db';
import { buttonResource, tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { requirePermission } from '../../authorization.js';
import { runCommand, type CommandGuard, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { auditActor } from '../../system-actor.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { businessDate } from './fields.js';
import type { EmploymentContext, EmploymentScope } from './types.js';
import {
  resolveModuleScope,
  getModuleViewableFields,
  trimModuleResponse,
  scopeSql,
  scopeAllows,
  authorizeInTransaction,
  resolveModuleScopeInTransaction,
  scopeAllowsInTransaction,
} from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { authorizeEmploymentResult } from '../permission/employment-replay.js';
import { trimEmploymentManagerReferences } from '../transfer/response-disclosure.js';
import { recordAudit } from '../../audit/record.js';
import { isEmploymentRecordVisible, visibleEmploymentRecords } from './visibility.js';
export type { EmploymentContext } from './types.js';
export { pageQuery, revision, uuidParam } from '../job/context.js';

export const EMPLOYEE_OBJECT = 'TenantBase.Employee';
export const EMPLOYMENT_OBJECT = 'TenantBase.EmploymentRecord';

export async function readContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  action: string,
  expectedRevision = 0,
  resource?: string,
  objectCode = EMPLOYMENT_OBJECT,
  pageCode?: string,
): Promise<EmploymentContext> {
  const tenant = tenantOf(c);
  const operation = action === 'tenant.employment.read' ? 'object.view' : action;
  await requirePermission(deps.authorize, {
    ...tenant,
    action: operation,
    resource: objectCode,
    ...(['object.create', 'object.update'].includes(operation) ? { fields: [] } : {}),
  });
  const now = deps.clock();
  const context = { ...tenant, now, expectedRevision, commandId: '' };
  const configuration = ['TenantBase.EmploymentSettings', 'TenantBase.EmploymentCustomField'].includes(objectCode);
  const scope = configuration
    ? undefined
    : await resolveModuleScope(deps, context, tenantLocalDate(now, tenant.timezone), objectCode, pageCode);
  const trustedScopeBypass = await deps.authorize({ ...tenant, action: 'data.scope.all' });
  if (resource && trustedScopeBypass) {
    await requirePermission(deps.authorize, {
      ...tenant,
      action: operation === 'object.view' ? 'tenant.employment.read' : 'tenant.employment.write',
      resource,
    });
  }
  const result = { ...context, scope, authorize: deps.authorize, objectCode, trustedScopeBypass };
  if (resource) {
    const creatorId = await withTenant(deps.db, tenant.tenantId, (tx) => requireEmployeeInScope(tx, result, resource));
    return { ...result, scopeEmployeeId: resource, scopeEmployeeCreatorId: creatorId };
  }
  return result;
}

/** 员工在 ctx 数据范围内（范围外与不存在同一个 404）；返回创建人（使用用户维度用）。入口与命令内复核共用。 */
export async function requireEmployeeInScope(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const creator = await employmentCreatorId(tx, ctx, employeeId);
  if (ctx.scope && !(await scopeAllowsInTransaction(tx, ctx.scope, { personId: employeeId, creatorId: creator })))
    throw new AppError('NOT_FOUND', '任职数据不存在');
  return creator;
}

export function readPageContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  page: 'list' | 'detail',
  resource?: string,
  objectCode = EMPLOYMENT_OBJECT,
) {
  return readContext(c, deps, 'tenant.employment.read', 0, resource, objectCode, `${objectCode}.${page}`);
}

export function employmentScopePredicate(
  scope: EmploymentScope | undefined,
  person: SQL,
  department?: SQL,
  creator?: SQL,
): SQL {
  return scope
    ? scopeSql(scope, { person, ...(department ? { org: department } : {}), ...(creator ? { creator } : {}) })
    : sql`true`;
}

export function requireEmploymentScope(
  ctx: EmploymentContext,
  employeeId?: string,
  departmentId?: string | null,
  creatorId?: string | null,
) {
  if (!ctx.scope || ctx.scope.all) return;
  const creator =
    creatorId === undefined ? (employeeId === ctx.scopeEmployeeId ? ctx.scopeEmployeeCreatorId : undefined) : creatorId;
  if (
    !employeeId ||
    !scopeAllows(ctx.scope, {
      personId: employeeId,
      ...(creator !== undefined ? { creatorId: creator } : {}),
      ...(departmentId !== undefined ? { orgId: departmentId } : {}),
    })
  )
    throw new AppError('NOT_FOUND', '任职数据不存在');
}

export function employmentCreator(tenantId: string, objectId: SQL, business = false): SQL {
  // DEC-198：创建人取最小元数据表（不随审计保留期清理）
  return sql`(SELECT a.creator_user_id FROM audit_object_creators a WHERE a.tenant_id=${tenantId}
    AND a.object_id=${objectId}::text
    AND a.action=${business ? 'employment.business.create' : 'employment.employee.create'}
    ORDER BY a.created_at LIMIT 1)`;
}

async function employmentCreatorId(tx: Tx, ctx: EmploymentContext, id: string, business = false) {
  if (!ctx.scope?.terms?.some((term) => term.dimension === 'using_user')) return undefined;
  const result = await tx.execute(
    sql`SELECT ${employmentCreator(ctx.tenantId, sql`${id}::uuid`, business)} AS creator`,
  );
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { creator: string | null }[];
  return rows[0]?.creator ?? null;
}

/**
 * 写入口径（新建业务、改部门、直接编辑 / 删除 / 撤回 / 重试）：带上员工、记录部门、创建人三个坐标，按数据范围各项的维度
 * 判定（scopeSql / scopeAllows 同一口径）——组织维度只看记录部门，汇报关系维度只看员工，使用用户维度只看创建人，
 * 其余维度要求部门与员工同时命中；各项之间取并集。不是“部门与员工任职一律同时命中”。
 * DEC-193：直接操作不随 DEC-177 的可见放宽；#72 取证结论后再定是否调整（TODO(需取证 #72)）。
 */
export async function requireScopedEmploymentObject(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  departmentId: string | null,
  businessId?: string,
) {
  if (!ctx.scope || ctx.scope.all) return;
  if (
    ctx.transferTarget?.employeeId === employeeId &&
    ctx.transferTarget.departmentId === departmentId &&
    (businessId === undefined || ctx.transferTarget.businessId === businessId)
  )
    return;
  const creatorId = businessId ? await employmentCreatorId(tx, ctx, businessId, true) : ctx.userId;
  if (!(await scopeAllowsInTransaction(tx, ctx.scope, { personId: employeeId, orgId: departmentId, creatorId })))
    throw new AppError('NOT_FOUND', '任职数据不存在');
}

/** DEC-177 单条可见判定的上下文封装；businessId 给出时按该业务的创建者判断“使用用户”维度。 */
export async function employmentRecordVisibleTo(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  departmentId: string | null,
  businessId?: string,
): Promise<boolean> {
  // 看全部 / 可信端口同样经 isEmploymentRecordVisible 校验员工属于本租户，不提前放行（PR #76 P2-1）。
  const creatorId = businessId ? await employmentCreatorId(tx, ctx, businessId, true) : ctx.userId;
  return isEmploymentRecordVisible(tx, ctx.tenantId, ctx.scope, { employeeId, departmentId, creatorId });
}

/**
 * DEC-178：联动（向后更新、负责人标志补写等）改写后续记录前调用。记录按 DEC-177 对操作人可见即可改写，
 * 不可见整单拒绝，保留 DEC-084 的拒绝码，提示由覆盖该范围的人员操作。
 */
export async function requireLinkedEmploymentRecord(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  departmentId: string | null,
  businessId: string,
): Promise<void> {
  if (!(await employmentRecordVisibleTo(tx, ctx, employeeId, departmentId, businessId)))
    throw new AppError('LINKED_RECORD_OUT_OF_SCOPE', '联动记录不在当前数据范围，请由覆盖该范围的人员操作');
}

export async function requireEmploymentWrite(
  ctx: EmploymentContext,
  operation: 'create' | 'update' | 'delete',
  payload: object,
  button?: string,
  objectCode = EMPLOYMENT_OBJECT,
  options: { readonly commandOnly?: boolean } = {},
): Promise<void> {
  if (!ctx.authorize) return;
  if (operation === 'delete') {
    await requirePermission(ctx.authorize, { ...ctx, action: 'object.delete', resource: objectCode });
  } else {
    const { fields, customFields, ...metadata } = payload as Record<string, unknown>;
    const actual = {
      ...metadata,
      ...(fields as Record<string, unknown> | undefined),
      ...Object.fromEntries(
        Object.entries((customFields ?? {}) as Record<string, unknown>).map(([id, value]) => [`custom:${id}`, value]),
      ),
    };
    const commandButtons = [
      'Employment.Submit',
      'Employment.Withdraw',
      'Employment.Revoke',
      'Employment.RetryActivation',
    ];
    if (!Object.keys(actual).length && !options.commandOnly && !commandButtons.includes(button ?? '')) {
      throw new AppError('VALIDATION_FAILED', '必须提供要写入的业务字段');
    }
    await requireObjectWrite(ctx.authorize, ctx, { objectCode, operation, payload: actual });
  }
  if (button)
    await requirePermission(ctx.authorize, {
      ...ctx,
      action: 'object.button',
      resource: buttonResource(
        objectCode,
        button,
        ['Employment.Import', 'Employee.Create'].includes(button) ? 'list' : 'detail',
      ),
    });
}

/** 任职接口按本人权限裁剪；审批节点详情另按节点表单裁剪（approval/disclosure.ts，DEC-057），参与人不获得临时数据范围。 */
export async function trimEmploymentResponse(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  value: unknown,
): Promise<unknown> {
  const objectCode = ctx.objectCode ?? EMPLOYMENT_OBJECT;
  const viewable = await getModuleViewableFields(deps, ctx, objectCode);
  if (viewable === undefined) return value;
  const visibleBefore = await visiblePreviousRecords(deps, ctx, value);
  const trim = (record: unknown): unknown => {
    if (Array.isArray(record)) return record.map(trim);
    if (!record || typeof record !== 'object') return record;
    const source = record as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(source)) {
      if (key === 'items') result.items = trim(field);
      else if (key === 'fields' && !Array.isArray(field))
        result.fields = Object.fromEntries(
          Object.entries((field ?? {}) as Record<string, unknown>).filter(([name]) => viewable.has(name)),
        );
      else if (key === 'customFields')
        result.customFields = Object.fromEntries(
          Object.entries((field ?? {}) as Record<string, unknown>).filter(([id]) => viewable.has(`custom:${id}`)),
        );
      else if (key === 'record') result.record = trim(field);
      else if (key === 'before') {
        const allowed = visibleBefore(source);
        result.before = allowed ? trim(field) : null;
        if (!allowed && Object.hasOwn(source, 'previousRecordId')) result.previousRecordId = null;
      } else if ((key === 'changes' || key === 'wholeRecordSkips') && Array.isArray(field))
        // DEC-120 的整条跳过提醒与 changes 同形，字段值同样按可见字段裁剪；reason 是协议元数据。
        result[key] = field.map((change) => {
          const current = change as Record<string, unknown> & { fields?: { field: string }[] };
          return {
            ...Object.fromEntries(
              Object.entries(current).filter(
                ([key]) => key === 'reason' || (key === 'businessId' ? viewable.has('id') : viewable.has(key)),
              ),
            ),
            fields: current.fields?.filter((entry) => viewable.has(entry.field.replace(/^preset:/, ''))),
          };
        });
      else if ((key === 'skipped' || key === 'warnings') && Array.isArray(field))
        result[key] = field.map((entry) => {
          const current = entry as Record<string, unknown> & { fields?: string[] };
          return {
            ...Object.fromEntries(
              Object.entries(current).filter(
                ([key]) => key === 'reason' || (key === 'businessId' ? viewable.has('id') : viewable.has(key)),
              ),
            ),
            ...(current.fields
              ? { fields: current.fields.filter((name) => viewable.has(name.replace(/^preset:/, ''))) }
              : {}),
          };
        });
      else if (
        // total / succeeded / failed 是批量编辑回执的协议元数据（R1-T16），contractNotice 是改期入职的合同提示（F-194），都不是任职字段
        [
          'notice',
          'contractNotice',
          'hasDataPermission',
          'page',
          'pageSize',
          'emptyReason',
          'total',
          'succeeded',
          'failed',
        ].includes(key) ||
        viewable.has(key)
      )
        result[key] = field;
    }
    return result;
  };
  // Flat employee/configuration DTOs use the shared helper; nested employment DTOs require field-level traversal.
  return objectCode === EMPLOYMENT_OBJECT
    ? trimEmploymentManagerReferences(deps, ctx, trim(value))
    : trimModuleResponse(deps, ctx, objectCode, value as Record<string, unknown>);
}

/**
 * 链上一条与本条同属一名员工，按 DEC-177 判断（员工当前在范围内即可见）；“使用用户”维度按前驱记录自己的创建者
 * 判断（PR #76 P3-1）。整份响应批量查询一次，不逐条回表。
 */
async function visiblePreviousRecords(deps: TenantRouteDeps, ctx: EmploymentContext, value: unknown) {
  type Before = { fields?: { departmentId?: string | null } } | null | undefined;
  const scope = ctx.scope;
  const key = (record: Record<string, unknown>) =>
    `${String(record.employeeId)}|${String(record.previousRecordId ?? '')}|${
      (record.before as Before)?.fields?.departmentId ?? ''
    }`;
  if (!scope || scope.all) return () => true;
  const targets = new Map<string, { employeeId: string; departmentId: string | null; previousId: string | null }>();
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const before = record.before as Before;
    if (before && typeof record.employeeId === 'string')
      targets.set(key(record), {
        employeeId: record.employeeId,
        departmentId: before.fields?.departmentId ?? null,
        previousId: typeof record.previousRecordId === 'string' ? record.previousRecordId : null,
      });
    collect(record.items);
    collect(record.record);
  };
  collect(value);
  const list = [...targets.entries()];
  if (!list.length) return () => false;
  const visible = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const creators = await previousCreators(
      tx,
      ctx,
      list.map(([, target]) => target.previousId),
    );
    const subjects = list.map(([, target]) => ({
      ...target,
      creatorId: target.previousId ? (creators.get(target.previousId) ?? null) : null,
    }));
    return visibleEmploymentRecords(tx, ctx.tenantId, scope, subjects);
  });
  const allowed = new Set(list.filter((_, index) => visible[index]).map(([id]) => id));
  return (record: Record<string, unknown>) => allowed.has(key(record));
}

/** 只有范围含“使用用户”维度时才需要前驱创建者。 */
async function previousCreators(tx: Tx, ctx: EmploymentContext, ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (!unique.length || !ctx.scope?.terms?.some((term) => term.dimension === 'using_user')) return new Map();
  const result = await tx.execute(sql`
    SELECT p.id::text AS id, ${employmentCreator(ctx.tenantId, sql`p.id`, true)} AS creator
    FROM unnest(${`{${unique.join(',')}}`}::uuid[]) AS p(id)
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
    id: string;
    creator: string | null;
  }[];
  return new Map(rows.map((row) => [row.id, row.creator]));
}

export function queryDate(c: Context, ctx: EmploymentContext): string {
  return businessDate(c.req.query('asOf') ?? tenantLocalDate(ctx.now, ctx.timezone));
}

export async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError('VALIDATION_FAILED', '请求必须为合法 JSON');
  }
}

/**
 * 命令事务内的上下文（F-195 / F-197）：授权器绑定本事务，数据范围按当前授权在本事务内重新解析；入口 readContext 取到的
 * 范围只是请求内快照，管不到入口放行之后、命令事务之前的撤权。同一事务只解析一次（按 tx 缓存），所以 guard 的前置检查、
 * 实际执行、提交前结果校验和重放复核看到的是同一份范围。
 */
const commandContexts = new WeakMap<
  Tx,
  { readonly ctx: EmploymentContext; readonly scoped: Promise<EmploymentContext> }
>();
export function commandContext(tx: Tx, deps: TenantRouteDeps, ctx: EmploymentContext): Promise<EmploymentContext> {
  const cached = commandContexts.get(tx);
  if (cached?.ctx === ctx) return cached.scoped;
  const authorize = authorizeInTransaction(deps.authorize, tx);
  const resolved = ctx.scope
    ? resolveModuleScopeInTransaction(deps, ctx, tx, ctx.objectCode ?? EMPLOYMENT_OBJECT)
    : Promise.resolve(undefined);
  const scoped = resolved.then((scope) => ({ ...ctx, authorize, scope }));
  commandContexts.set(tx, { ctx, scoped });
  return scoped;
}

/**
 * guard.before 在事务内重算了比 commandContext 更细的上下文（如同单来源 / 目标部门例外）时，把它登记为本事务的命令上下文：
 * 首次执行、直接重放、失败回查和结果复核都改用这一份，不再带着入口的旧例外。
 */
export function adoptCommandContext(tx: Tx, ctx: EmploymentContext, scoped: EmploymentContext): void {
  commandContexts.set(tx, { ctx, scoped: Promise.resolve(scoped) });
}

/** 带事务内范围标记的 CommandGuard：runWrite 对它改用 commandContext 执行与校验结果，见 runWrite。 */
export interface ScopedCommandGuard extends CommandGuard {
  readonly scoped: true;
}
export const scopedGuard = (guard: CommandGuard): ScopedCommandGuard => ({ ...guard, scoped: true });
const isScopedGuard = (guard: CommandGuard | undefined): guard is ScopedCommandGuard =>
  !!guard && (guard as { scoped?: boolean }).scoped === true;

/** 重放复核：命中台账后，在同一事务内用事务内范围校验业务当前值、原响应快照与命令足迹（authorizeEmploymentResult）。 */
function withReplayRecheck(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  commandId: string,
  guard: ScopedCommandGuard,
): CommandGuard {
  return {
    ...guard,
    replayed: async (tx, replay) => {
      await guard.replayed?.(tx, replay);
      await authorizeEmploymentResult(tx, await commandContext(tx, deps, ctx), deps.authorize, commandId, replay.body);
    },
  };
}

export async function runWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  input: unknown,
  execute: (tx: Tx, context: EmploymentContext) => Promise<CommandResult>,
  /**
   * 可选：命令事务内的当前权限复核（CommandGuard，经 ledgerExit 覆盖首次 / 重放 / 回查）；
   * 带 `scopedGuard` 标记的 guard 还让执行与结果校验改用事务内重新解析的数据范围（commandContext），重放命中台账后
   * 同一事务内再校验原响应，这类出口不再跑事务外、用入口旧范围的那次结果复核；
   * project：固定形状回执（不是任职对象）的显式投影，替代通用任职字段裁剪；缺省两项与之前完全相同。
   */
  options: { readonly guard?: CommandGuard; readonly project?: (body: unknown) => unknown } = {},
) {
  const key = c.req.header('idempotency-key');
  const scoped = isScopedGuard(options.guard) ? options.guard : undefined;
  const guard = scoped ? withReplayRecheck(deps, ctx, key!, scoped) : options.guard;
  const result = await runCommand(deps.db, ctx, {
    id: key,
    fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input },
    ...(guard ? { guard } : {}),
    execute: async (tx, commandId) => {
      const base = scoped
        ? await commandContext(tx, deps, ctx)
        : { ...ctx, authorize: authorizeInTransaction(deps.authorize, tx) };
      const context = { ...base, commandId };
      const commandResult = await execute(tx, context);
      // Validate linked writes in the command transaction so an out-of-scope footprint rolls back atomically.
      await authorizeEmploymentResult(tx, context, deps.authorize, commandId, commandResult.body);
      return commandResult;
    },
  });
  if (!scoped)
    await withTenant(deps.db, ctx.tenantId, (tx) =>
      authorizeEmploymentResult(tx, ctx, deps.authorize, key!, result.body),
    );
  const payload = result.body as { revision?: number } | null;
  if (payload?.revision !== undefined) c.header('ETag', `"${payload.revision}"`);
  const body = options.project ? options.project(result.body) : await trimEmploymentResponse(deps, ctx, result.body);
  return c.json(body, result.status);
}

export function assertRevision(expected: number, actual: number): void {
  if (expected !== actual)
    throw new AppError('REVISION_CONFLICT', '任职数据已变更，请刷新后显式重提', { expected, actual });
}

/** DEC-019：字段快照、领域事件和业务写入由同一个租户事务提交。 */
export async function auditEmployment(
  tx: Tx,
  ctx: EmploymentContext,
  action: string,
  objectType: string,
  objectId: string,
  before: unknown,
  after: unknown,
  payloadVersionId?: string,
  meta?: Readonly<Record<string, unknown>>,
  /**
   * 写入方确知归属时显式给出（离职单 / 撤销记录 / 效果台账，DEC-197；R2-T03 §9）。兼职记录 / 申请另给 orgId = 兼职部门
   * （0058 推不出这两类对象的部门，R2-T05 §7.4）；不在业务头表的对象（兼职申请、离职单）outbox 员工取 scope.employeeId。
   */
  scope?: { readonly employeeId?: string | null; readonly orgId?: string | null },
): Promise<void> {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action,
    objectType,
    objectId,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    ...(scope ? { scope } : {}),
  });
  await tx.execute(sql`
    WITH ownership AS (
      SELECT employee_id, id AS business_id FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${objectId}::uuid
    ), queued AS (
      INSERT INTO employment_outbox(
        tenant_id,employee_id,business_id,event_type,object_type,object_id,command_id,payload,
        payload_version_id,created_at
      )
      SELECT ${ctx.tenantId},COALESCE(ownership.employee_id,${scope?.employeeId ?? null}::uuid),ownership.business_id,
        ${action},${objectType},${objectId},
        ${ctx.commandId},${JSON.stringify({ before, after, ...(meta ? { meta } : {}) })}::jsonb,
        ${payloadVersionId ?? null}::uuid,
        ${ctx.now.toISOString()}::timestamptz
      FROM (SELECT 1) seed LEFT JOIN ownership ON true RETURNING id
    )
    INSERT INTO employment_outbox_attempts(tenant_id,outbox_id,attempt_no,state,created_at)
    SELECT ${ctx.tenantId},id,1,'pending',${ctx.now.toISOString()}::timestamptz FROM queued
  `);
}
