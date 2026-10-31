/**
 * 组织调整申请头的写授权（R2-T08 §6.3 授权矩阵前两层；DEC-644 A-3 三层取严，F-287）。
 * ① 按钮 + OrganizationApproval 字段编辑权，审批主体组织在 OrganizationApproval 范围；
 * ② 调整范围所选组织逐个在组织对象范围（与 `authorizeOrgResult` 同口径）。范围外一律 404（同无范围口径）。
 * 不写字段的动作（作废、整单校验）走 `authorizeHeadAction`：同样的按钮与范围，没有字段这一层。
 * 当前审批人（审批编辑，入口随 10c）另须 `EditApprovalIngApply@detail`，范围按审批人自己的权限判，不豁免主体组织。
 * 调用方在事务内调用：命令守卫（首次与重放都经过）与审批适配器 `edit` 共用这一个入口。
 * 组织明细（10b2）走 `authorizeItem`：入口 / 行按钮 + 主体组织在主对象范围 + 行涉及的组织（目标、新上级、转移目标）
 * 逐个在组织对象范围；停用整支的连带下级在写服务展开时经 `orgScopeAuthorizer` 同口径判。调整范围本身不在这一层重判。
 */
import { type Tx } from '@italent/db';
import { buttonResource, MODULE_OBJECTS, ORG_ADJUSTMENT_OBJECT_CODE, type ButtonLevel } from '@italent/domain';
import type { CascadeAuthorizer } from '../org/deactivation.js';
import { requirePermission, type Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction, scopeAllows } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { authorizeOrgResult } from '../permission/org-result-scope.js';

const OBJECT = ORG_ADJUSTMENT_OBJECT_CODE;
export type HeadButton = readonly [code: string, level: ButtonLevel];
export const HEAD_BUTTONS = {
  create: ['AddAdjustOrgApprovalBtn', 'list'],
  update: ['EditAdjustOrgDetailBtn', 'detail'],
  void: ['OrganizationApprovalDelete', 'list_row'],
  approve: ['EditApprovalIngApply', 'detail'],
} as const satisfies Record<string, HeadButton>;

export interface HeadAuthorization {
  readonly actor: 'applicant' | 'current_approver';
  readonly operation: 'create' | 'update';
  /** 本次写入的头字段编码。 */
  readonly fields: readonly string[];
  readonly subjectOrgId: string;
  readonly rangeOrgIds: readonly string[];
  /** 默认按操作取新建 / 编辑按钮；作废传 `HEAD_BUTTONS.void`。 */
  readonly button?: HeadButton;
}

type ActionInput = Omit<HeadAuthorization, 'fields'>;

interface Deps {
  readonly authorize: Authorizer;
  readonly clock: () => Date;
}

export async function authorizeHead(tx: Tx, deps: Deps, ctx: TenantContext, input: HeadAuthorization): Promise<void> {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  await requireButtons(bound, ctx, input);
  if (input.fields.length > 0) {
    await requireObjectWrite(bound.authorize, ctx, {
      objectCode: OBJECT,
      operation: input.operation,
      payload: Object.fromEntries(input.fields.map((field) => [field, true])),
    });
  }
  await requireScopes(tx, bound, ctx, input);
}

/** 不写字段的动作（作废、整单校验）：按钮 + 主体组织与调整范围。 */
export async function authorizeHeadAction(tx: Tx, deps: Deps, ctx: TenantContext, input: ActionInput): Promise<void> {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  await requireButtons(bound, ctx, input);
  await requireScopes(tx, bound, ctx, input);
}

async function requireButtons(bound: Deps, ctx: TenantContext, input: ActionInput) {
  const [code, level] = input.button ?? HEAD_BUTTONS[input.operation];
  const buttons: HeadButton[] = [[code, level]];
  if (input.actor === 'current_approver') buttons.push(HEAD_BUTTONS.approve);
  for (const [buttonCode, buttonLevel] of buttons) {
    await requirePermission(bound.authorize, {
      ...ctx,
      action: 'object.button',
      resource: buttonResource(OBJECT, buttonCode, buttonLevel),
    });
  }
}

async function requireScopes(tx: Tx, bound: Deps, ctx: TenantContext, input: ActionInput) {
  const main = await resolveModuleScopeInTransaction(bound, ctx, tx, OBJECT);
  if (!scopeAllows(main, { orgId: input.subjectOrgId })) throw new AppError('NOT_FOUND', '组织调整申请不存在');
  const orgScope = await resolveModuleScopeInTransaction(bound, ctx, tx, MODULE_OBJECTS.organization.code);
  const scoped = { ...ctx, expectedRevision: 0, commandId: '', now: bound.clock() };
  for (const orgId of input.rangeOrgIds) await authorizeOrgResult(tx, scoped, orgScope, orgId, false);
}

export interface ItemAuthorization {
  /** 入口或行按钮：[对象编码, 按钮编码, 层级]。 */
  readonly button: readonly [objectCode: string, code: string, level: ButtonLevel];
  readonly subjectOrgId: string;
  /** 行涉及的已有组织（空值与重复自动略去）。 */
  readonly orgIds: readonly (string | null | undefined)[];
}

/** 组织明细写授权：按钮 → 主体组织在主对象范围（404 同申请单不存在）→ 行组织逐个在组织对象范围（404 同组织不存在）。 */
export async function authorizeItem(tx: Tx, deps: Deps, ctx: TenantContext, input: ItemAuthorization): Promise<void> {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const [objectCode, code, level] = input.button;
  await requirePermission(bound.authorize, {
    ...ctx,
    action: 'object.button',
    resource: buttonResource(objectCode, code, level),
  });
  const orgIds = [...new Set(input.orgIds.filter((orgId): orgId is string => Boolean(orgId)))];
  await requireScopes(tx, bound, ctx, {
    actor: 'applicant',
    operation: 'update',
    subjectOrgId: input.subjectOrgId,
    rangeOrgIds: orgIds,
  });
}

/** 停用整支展开时判连带下级（与 `authorizeItem` 的组织层同口径）。 */
export function orgScopeAuthorizer(deps: Deps, ctx: TenantContext): CascadeAuthorizer {
  return async (tx, orgIds) => {
    const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
    const orgScope = await resolveModuleScopeInTransaction(bound, ctx, tx, MODULE_OBJECTS.organization.code);
    const scoped = { ...ctx, expectedRevision: 0, commandId: '', now: bound.clock() };
    for (const orgId of orgIds) await authorizeOrgResult(tx, scoped, orgScope, orgId, false);
  };
}
