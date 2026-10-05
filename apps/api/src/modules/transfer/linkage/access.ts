/**
 * 联动写入口的事务内授权（PR #74 第二轮 P1-1 / P1-2 / P1-5）。每个联动写入映射到它真正改写的对象与字段：
 * - 任职对象：联动字段本身（TRANSFER_LINKAGE_FIELDS），以及职责转交改写的下属直线 / 虚线经理；
 * - 组织对象：组织角色转交改写的负责人 / 店长 / HRBP，且组织须在操作人的组织范围内（DEC-178，不可见整单拒绝）；
 * - 合同对象：目标合同按合同模块的对象范围（含“我创建的”，DEC-180④）、字段权限与“变更”按钮判定。
 * 保存、修改联动与子项重试共用；路由在命令外先按当前权限判一次（幂等重放同样经过），命令内再判一次。
 * 定时生效与审批通过端口没有操作人访问上下文，只执行已授权的单据。
 */
import { sql, type Tx } from '@italent/db';
import { buttonResource, CONTRACT_OBJECT, contractAction, MODULE_OBJECTS } from '@italent/domain';
import { requirePermission, type Authorizer } from '../../../authorization.js';
import { AppError } from '../../../errors.js';
import type { TenantRouteDeps } from '../../../routes.js';
import type { TenantContext } from '../../../tenant-context.js';
import { checkFields, checkScope } from '../../contracts/context.js';
import { EMPLOYMENT_OBJECT } from '../../employment/context.js';
import { rowsOf } from '../../employment/record-store.js';
import type { EmploymentContext } from '../../employment/types.js';
import { resolveModuleScope, scopeAllowsInTransaction, type ModuleScope } from '../../permission/module-access.js';
import { requireObjectWrite } from '../../permission/object-write.js';
import { linkageFieldValues } from './approval.js';
import type { DutyRelation, LinkageOptions, OrgRole } from './input.js';
import { RELATION_FIELDS, ROLE_FIELDS } from './validation.js';

const ORG_OBJECT = MODULE_OBJECTS.organization.code;

/** 操作人对联动目标对象的范围，在路由里按当前权限解析（不信任请求体）。 */
export interface LinkageAccess {
  readonly contractScope?: ModuleScope;
  readonly orgScope?: ModuleScope;
}

export async function resolveLinkageAccess(
  deps: Pick<TenantRouteDeps, 'authorize' | 'db' | 'clock'>,
  tenant: TenantContext,
  options: LinkageOptions | null,
  before: LinkageOptions | null = null,
): Promise<LinkageAccess> {
  // 原选项里的合同同样要判范围：删除或改动合同联动也是在改写对该合同的变更计划（第三轮 P1-2）。
  const contractScope =
    options?.contract || before?.contract
      ? await resolveModuleScope(deps, tenant, undefined, CONTRACT_OBJECT, `${CONTRACT_OBJECT}.list`)
      : undefined;
  const orgScope = options?.dutyTransfer?.orgRoles.length
    ? await resolveModuleScope(deps, tenant, undefined, ORG_OBJECT)
    : undefined;
  return { ...(contractScope ? { contractScope } : {}), ...(orgScope ? { orgScope } : {}) };
}

/**
 * 新旧选项不同的任职联动字段（与审批载荷同一编码）。清空、置 false、删掉嵌套字段同样算改动（第三轮 P1-2），
 * 新建联动时原选项为空，即本次设置的全部字段。
 */
export function changedLinkageFields(before: LinkageOptions | null, after: LinkageOptions): Record<string, null> {
  const [old, next] = [linkageFieldValues(before), linkageFieldValues(after)];
  const codes = Object.keys(next).filter((code) => JSON.stringify(old[code]) !== JSON.stringify(next[code]));
  return Object.fromEntries(codes.map((code) => [code, null]));
}

export interface LinkageWrite {
  readonly employeeId: string;
  readonly operation: 'create' | 'update';
  readonly options: LinkageOptions;
  /** 修改前的选项（新建为 null）；按新旧差异授权。 */
  readonly before?: LinkageOptions | null;
}

export async function authorizeLinkageWrite(
  tx: Tx,
  ctx: EmploymentContext,
  access: LinkageAccess | undefined,
  input: LinkageWrite,
): Promise<void> {
  if (!access || !ctx.authorize) return;
  const { options } = input;
  const before = input.before ?? null;
  const fields = changedLinkageFields(before, options);
  if (Object.keys(fields).length)
    await requireObjectWrite(ctx.authorize, ctx, {
      objectCode: EMPLOYMENT_OBJECT,
      operation: input.operation,
      payload: fields,
    });
  for (const relation of new Set(options.dutyTransfer?.subordinates.map((item) => item.relation)))
    await authorizeSubordinateField(ctx, relation);
  for (const item of options.dutyTransfer?.orgRoles ?? [])
    await authorizeOrgRole(tx, ctx, access, item.orgId, item.role);
  if (Object.hasOwn(fields, 'contractChange'))
    await authorizeContractChange(tx, ctx, access, input.employeeId, before?.contract ?? null, options.contract);
}

/** P1-5：职责转交原地改写下属的直线 / 虚线经理，按真实字段编辑权判定。 */
export async function authorizeSubordinateField(ctx: EmploymentContext, relation: DutyRelation) {
  if (!ctx.authorize) return;
  await requireObjectWrite(ctx.authorize, ctx, {
    objectCode: EMPLOYMENT_OBJECT,
    operation: 'update',
    payload: { [RELATION_FIELDS[relation]]: null },
  });
}

/**
 * P1-1：组织角色转交改写组织版本。组织不在操作人组织范围内整单拒绝（DEC-178，保留 DEC-084 拒绝码）。
 * TODO(F-017)：F-017 合并后改用其 requireTransferOrganizationScope（同一组织联动授权，DEC-194）。
 */
export async function authorizeOrgRole(
  tx: Tx,
  ctx: EmploymentContext,
  access: LinkageAccess | undefined,
  orgId: string,
  role: OrgRole,
) {
  if (!access || !ctx.authorize) return;
  if (!access.orgScope || !(await scopeAllowsInTransaction(tx, access.orgScope, { orgId })))
    throw new AppError('LINKED_RECORD_OUT_OF_SCOPE', '联动记录不在当前数据范围，请由覆盖该范围的人员操作');
  await requireObjectWrite(ctx.authorize, ctx, {
    objectCode: ORG_OBJECT,
    operation: 'update',
    payload: { [ROLE_FIELDS[role]]: null },
  });
}

/**
 * P1-2：按目标合同的真实创建人判定合同范围（“我创建的”），新旧目标都要判；变动（含删掉）的合同字段按合同字段编辑权，
 * 仍保留合同变更时校验“变更”按钮。
 */
async function authorizeContractChange(
  tx: Tx,
  ctx: EmploymentContext,
  access: LinkageAccess,
  employeeId: string,
  before: LinkageOptions['contract'],
  after: LinkageOptions['contract'],
) {
  const authorize: Authorizer = ctx.authorize!;
  if (!access.contractScope) throw new AppError('NOT_FOUND', '合同数据不存在');
  const contractCtx = { ...ctx, scope: access.contractScope, authorize };
  for (const targetId of new Set([before?.targetId, after?.targetId].filter((id): id is string => !!id))) {
    const [target] = rowsOf<{ createdBy: string | null; employeeId: string }>(
      await tx.execute(sql`SELECT created_by AS "createdBy", employee_id AS "employeeId" FROM contract_records
        WHERE tenant_id=${ctx.tenantId} AND id=${targetId}::uuid AND NOT deleted`),
    );
    if (!target || target.employeeId !== employeeId) throw new AppError('NOT_FOUND', '合同不存在');
    await checkScope(tx, contractCtx, employeeId, target.createdBy ?? undefined);
  }
  const changed = changedContractFields(before, after);
  if (Object.keys(changed).length) await checkFields(contractCtx, 'update', changed);
  if (after)
    await requirePermission(authorize, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: 'object.button',
      resource: buttonResource(CONTRACT_OBJECT, contractAction('change', 'direct'), 'detail'),
    });
}

/** 新旧合同变更里值不同的合同字段（目标换了时两边全部字段都算）；自定义字段按 customFields 子键比较。 */
function changedContractFields(before: LinkageOptions['contract'], after: LinkageOptions['contract']) {
  const sameTarget = before?.targetId === after?.targetId;
  const old = sameTarget ? (before?.fields ?? {}) : {};
  const next = after?.fields ?? {};
  const others = sameTarget ? {} : (before?.fields ?? {});
  const keys = new Set([...Object.keys(old), ...Object.keys(next), ...Object.keys(others)]);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key === 'customFields') {
      const custom = changedCustom(old.customFields, next.customFields, others.customFields);
      if (Object.keys(custom).length) result.customFields = custom;
    } else if (
      !sameTarget ||
      JSON.stringify(old[key as keyof typeof old]) !== JSON.stringify(next[key as keyof typeof next])
    )
      result[key] = null;
  }
  return result;
}

function changedCustom(...sources: (Readonly<Record<string, unknown>> | undefined)[]) {
  const [old = {}, next = {}, others = {}] = sources;
  const ids = new Set([...Object.keys(old), ...Object.keys(next), ...Object.keys(others)]);
  return Object.fromEntries(
    [...ids]
      .filter((id) => Object.hasOwn(others, id) || JSON.stringify(old[id]) !== JSON.stringify(next[id]))
      .map((id) => [id, null]),
  );
}
