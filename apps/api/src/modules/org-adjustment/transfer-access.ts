/**
 * 调动明细的授权与调动表单校验（R2-T08 §6.3，BE-11c-b 第 2 轮）：与人工调动（`POST /transfers/employees/:id`）同一条链——
 * normalize → 来源员工（HR 入口按钮、数据范围、不能调自己）→ 任职字段写权 → 预览（目标部门范围、表单规则）→
 * 联动授权（合同、职责转交、组织角色，按新旧选项差异）→ 带编（编制对象范围）。
 * 保存、改、删、提交、重提、重放六个入口共用本文件：**一律在命令事务内、锁住申请单之后**，用当时库里的行与当前权限判
 * （上下文、联动目标范围都在事务内解析，不在锁外先算），并且新旧两侧都判——删除时新值为空、提交 / 重提 / 重放时旧值为空。
 * 不判 `mode`（调整单一律按“直接生效”走执行器）、不要求提交 / 确认（`submit` 恒为 false，由审批单驱动）。
 */
import type { Tx } from '@italent/db';
import {
  buttonResource,
  CONTRACT_OBJECT,
  contractAction,
  ORG_ADJUSTMENT_CONTRACT_CONTAINER,
  ORG_ADJUSTMENT_OBJECT_CODE,
  tenantLocalDate,
} from '@italent/domain';
import { requirePermission, type Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { employmentCapacityContext } from '../permission/module-capacity-authorization.js';
import { carriedCandidates } from '../establishment/carried-candidates.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { findCurrentRecord } from '../employment/read-model.js';
import type { EmploymentContext } from '../employment/types.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { requireTransferSource } from '../transfer/access.js';
import {
  authorizeLinkageWrite,
  authorizeOrgRole,
  authorizeSubordinateField,
  type LinkageAccess,
} from '../transfer/linkage/access.js';
import type { LinkageOptions } from '../transfer/linkage/input.js';
import { normalizeLinkage } from '../transfer/linkage/input.js';
import { previewTransfer } from '../transfer/preview.js';
import { normalizeTransferInput, requireTransferWrite } from '../transfer/service.js';
import { authorizeItem, HEAD_BUTTONS } from './access.js';
import type { AdjustmentView } from './service.js';
import { transferRaw, type TransferContent, type TransferGate } from './transfer-items.js';
import { loadTransfers, type TransferItem } from './transfer-items-store.js';

const OBJECT = ORG_ADJUSTMENT_OBJECT_CODE;
const INITIATOR = 'hr';

export interface TransferAuthorityDeps {
  readonly authorize: Authorizer;
  readonly clock: () => Date;
}

/** 内容列 → 调动明细字段编码（§6.3 逐字段写权）；虚线经理随直线经理。 */
const FIELD_CODE: Readonly<Record<string, string>> = {
  employeeId: 'transferItems.employeeId',
  departmentId: 'transferItems.departmentId',
  departmentItemId: 'transferItems.departmentId',
  positionId: 'transferItems.positionId',
  postId: 'transferItems.postId',
  levelId: 'transferItems.levelId',
  directManagerId: 'transferItems.directManagerId',
  dottedManagerId: 'transferItems.directManagerId',
  withEstablishment: 'transferItems.withEstablishment',
};
/** 联动键 → 字段编码；合同变更走外部字段容器（逐行编码随读侧，§4.5）。 */
export const LINKAGE_CODE: Readonly<Record<string, string>> = {
  dutyTransfer: 'transferItems.dutyTransfer',
  onTrial: 'transferItems.trial',
  adjustSalary: 'transferItems.adjustSalary',
  contract: ORG_ADJUSTMENT_CONTRACT_CONTAINER,
};

const emptyValue = (value: unknown) => value === null || value === undefined || value === '' || value === false;
const same = (a: unknown, b: unknown) => (emptyValue(a) && emptyValue(b)) || JSON.stringify(a) === JSON.stringify(b);

/** 新旧内容里值不同的调动明细字段编码；新建时旧侧为空、删除时新侧为空，置空 / 置 false 同样算改动。 */
export function changedTransferFields(before: TransferContent | null, after: TransferContent | null) {
  const codes = new Set<string>();
  const [old, next] = [before as Record<string, unknown> | null, after as Record<string, unknown> | null];
  for (const [key, code] of Object.entries(FIELD_CODE)) {
    if (!same(old?.[key], next?.[key])) codes.add(code);
  }
  for (const [key, code] of Object.entries(LINKAGE_CODE)) {
    if (!same(before?.linkage?.[key as keyof LinkageOptions], after?.linkage?.[key as keyof LinkageOptions])) {
      codes.add(code);
    }
  }
  return Object.fromEntries([...codes].map((code) => [code, null]));
}

interface Env {
  readonly deps: TransferAuthorityDeps;
  readonly base: TenantContext;
}
type View = Pick<AdjustmentView, 'approvalSubjectOrgId' | 'effectiveDate'>;

const contexts = new WeakMap<Tx, { readonly base: TenantContext; readonly built: Promise<EmploymentContext> }>();

/** 任职对象上下文：对象 create 权 + 任职范围，授权器与范围都绑本事务（同一事务同一请求只解析一次）。 */
function employment(tx: Tx, { deps, base }: Env): Promise<EmploymentContext> {
  const cached = contexts.get(tx);
  if (cached?.base === base) return cached.built;
  const built = (async (): Promise<EmploymentContext> => {
    const authorize = authorizeInTransaction(deps.authorize, tx);
    const tenant = { tenantId: base.tenantId, userId: base.userId, timezone: base.timezone };
    await requirePermission(authorize, { ...tenant, action: 'object.create', resource: EMPLOYMENT_OBJECT, fields: [] });
    return {
      ...base,
      now: deps.clock(),
      expectedRevision: 0,
      commandId: '',
      scope: await resolveModuleScopeInTransaction(deps, base, tx, EMPLOYMENT_OBJECT),
      authorize,
      objectCode: EMPLOYMENT_OBJECT,
      trustedScopeBypass: await authorize({ ...tenant, action: 'data.scope.all' }),
    };
  })();
  contexts.set(tx, { base, built });
  return built;
}

/** 联动目标范围（合同）：新旧任一侧有合同才解析，事务内。 */
async function linkageAccess(
  tx: Tx,
  { deps }: Env,
  ctx: EmploymentContext,
  ...sides: (LinkageOptions | null | undefined)[]
) {
  if (!sides.some((side) => side?.contract)) return {} as LinkageAccess;
  const contractScope = await resolveModuleScopeInTransaction(
    deps,
    ctx,
    tx,
    CONTRACT_OBJECT,
    `${CONTRACT_OBJECT}.list`,
  );
  return { contractScope } satisfies LinkageAccess;
}

/** 旧值一侧：职责转交改写的下属经理 / 组织角色字段，旧选项里出现过的也要有当前编辑权（authorizeLinkageWrite 只看新值）。 */
async function authorizeOldDuty(tx: Tx, ctx: EmploymentContext, access: LinkageAccess, before: LinkageOptions | null) {
  const duty = before?.dutyTransfer;
  if (!duty) return;
  for (const relation of new Set(duty.subordinates.map((item) => item.relation))) {
    await authorizeSubordinateField(ctx, relation);
  }
  for (const item of duty.orgRoles) await authorizeOrgRole(tx, ctx, access, item.orgId, item.role);
}

/** 删掉 / 清空合同联动同样是在改写对该合同的变更计划：要合同“变更”按钮（authorizeLinkageWrite 只在新值有合同时判）。 */
async function authorizeContractClear(
  ctx: EmploymentContext,
  before: LinkageOptions | null,
  after: LinkageOptions | null,
) {
  if (!before?.contract || after?.contract) return;
  await requirePermission(ctx.authorize!, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: 'object.button',
    resource: buttonResource(CONTRACT_OBJECT, contractAction('change', 'direct'), 'detail'),
  });
}

/**
 * 带编（§6.3“带编”行）：新旧任一侧勾选带编，就按编制对象范围判来源 / 新旧目标部门（与人工调动 carryEstablishment 同一函数），
 * 执行器以系统身份写编制，不再判操作人权限，所以必须在这里判。
 */
async function authorizeEstablishment(
  tx: Tx,
  ctx: EmploymentContext,
  view: Pick<AdjustmentView, 'effectiveDate'>,
  employeeId: string,
  before: TransferContent | null,
  after: TransferContent | null,
) {
  if (!before?.withEstablishment && !after?.withEstablishment) return;
  const source = await findCurrentRecord(tx, ctx.tenantId, employeeId, view.effectiveDate);
  const orgIds = [source?.fields.departmentId, before?.departmentId, after?.departmentId].filter(
    (orgId): orgId is string => typeof orgId === 'string',
  );
  if (!orgIds.length) return;
  const capacity = await employmentCapacityContext(tx, ctx);
  await carriedCandidates(tx, capacity, orgIds, view.effectiveDate, tenantLocalDate(ctx.now, ctx.timezone));
}

/** 新旧两侧共用的前置：写按钮 + 主体组织在主对象范围 + 新旧目标部门在组织对象范围 + 字段写权 + 旧值一侧联动与带编。 */
async function authorizeChange(
  tx: Tx,
  env: Env,
  view: View,
  ctx: EmploymentContext,
  employeeId: string,
  before: TransferItem | null,
  after: TransferContent | null,
) {
  await authorizeItem(tx, env.deps, env.base, {
    button: [OBJECT, ...HEAD_BUTTONS.update],
    subjectOrgId: view.approvalSubjectOrgId,
    orgIds: [before?.departmentId, after?.departmentId],
  });
  await requireObjectWrite(ctx.authorize!, env.base, {
    objectCode: OBJECT,
    operation: 'update',
    payload: changedTransferFields(before, after),
  });
  const access = await linkageAccess(tx, env, ctx, before?.linkage, after?.linkage);
  await authorizeOldDuty(tx, ctx, access, before?.linkage ?? null);
  await authorizeContractClear(ctx, before?.linkage ?? null, after?.linkage ?? null);
  await authorizeEstablishment(tx, ctx, view, employeeId, before, after);
  return access;
}

/**
 * 联动白名单（P1-4）：本片快照只覆盖合同变更 / 调薪 / 试岗 / 职责转交；兼职终止、电子签、交接、社保调整
 * 执行器会照做，但审批人看不到也盲审不到，所以入口一律拒绝（空值 / null 等同未设置，放行）。
 */
export const UNSUPPORTED_LINKAGE = [
  'partTimes',
  'esign',
  'handover',
  'adjustedInsuranceRegionCode',
  'adjustedInsurancePlanId',
  'adjustedInsuranceCompanyId',
] as const;

export function assertLinkageSupported(linkage: unknown): void {
  const given = (linkage ?? {}) as Record<string, unknown>;
  const used = UNSUPPORTED_LINKAGE.filter((key) => {
    const value = given[key];
    return value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0);
  });
  if (!used.length) return;
  throw new AppError('VALIDATION_FAILED', '本版调动明细暂不支持该联动，请改用人工调动', {
    reason: 'ORG_ADJUSTMENT_LINKAGE_UNSUPPORTED',
    fields: Object.fromEntries(used.map((key) => [`linkage.${key}`, '组织调整调动明细暂不支持'])),
  });
}

async function saveRow(
  tx: Tx,
  env: Env,
  view: View,
  employeeId: string,
  draft: TransferContent,
  before: TransferItem | null,
) {
  assertLinkageSupported(draft.linkage);
  const ctx = await employment(tx, env);
  const access = await authorizeChange(tx, env, view, ctx, employeeId, before, draft);
  const input = await normalizeTransferInput(tx, ctx, transferRaw(view.effectiveDate, draft));
  await requireTransferSource(tx, ctx, employeeId, INITIATOR);
  await requireTransferWrite(ctx, input);
  // 目标部门是同单新增组织时没有正式 ID：预览只判已选的部门（未选部门的场景表单允许预览）
  const preview = await previewTransfer(tx, ctx, employeeId, input);
  await requireTransferWrite(preview.context, input);
  await authorizeLinkageWrite(tx, ctx, access, {
    employeeId,
    operation: before ? 'update' : 'create',
    options: input.linkage ?? normalizeLinkage({}),
    before: before?.linkage ?? null,
  });
  return input;
}

async function removeRow(tx: Tx, env: Env, view: View, row: TransferItem) {
  const ctx = await employment(tx, env);
  const access = await authorizeChange(tx, env, view, ctx, row.employeeId, row, null);
  await requireTransferSource(tx, ctx, row.employeeId, INITIATOR);
  await authorizeLinkageWrite(tx, ctx, access, {
    employeeId: row.employeeId,
    operation: 'update',
    options: normalizeLinkage({}),
    before: row.linkage,
  });
}

export function transferGate(deps: TransferAuthorityDeps, base: TenantContext): TransferGate {
  const env = { deps, base };
  return {
    save: (tx, view, employeeId, draft, before) => saveRow(tx, env, view, employeeId, draft, before),
    remove: (tx, view, row) => removeRow(tx, env, view, row),
    /** 提交 / 重提 / 保存类重放：库里（或台账结果里）的行全部按新建口径（before = null）再判一遍当前权限。 */
    async rejudge(tx, view, rows) {
      for (const row of rows) await saveRow(tx, env, view, row.employeeId, row, null);
    },
    /** 删除类重放：被删的行是旧值，按删除口径再判（不重写）。 */
    async rejudgeRemoved(tx, view, rows) {
      for (const row of rows) await removeRow(tx, env, view, row);
    },
  };
}

/**
 * 提交（路由 10）与审批中心重提共用（§6.3“提交 / 重提”列）：锁住申请单之后，按库里当前的调动行逐行走保存同一条授权链。
 * 没有调动行时什么都不做。
 */
export async function authorizeTransferRows(
  tx: Tx,
  deps: TransferAuthorityDeps,
  ctx: TenantContext,
  view: AdjustmentView,
): Promise<void> {
  const rows = await loadTransfers(tx, ctx.tenantId, view.id);
  if (rows.length) await transferGate(deps, ctx).rejudge(tx, view, rows);
}
