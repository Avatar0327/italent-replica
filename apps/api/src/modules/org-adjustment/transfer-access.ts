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
  CONTRACT_OBJECT,
  ORG_ADJUSTMENT_CONTRACT_CONTAINER,
  ORG_ADJUSTMENT_OBJECT_CODE,
  tenantLocalDate,
} from '@italent/domain';
import { requirePermission, type Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { employmentCapacityContext } from '../permission/module-capacity-authorization.js';
import { carriedCandidates } from '../establishment/carried-candidates.js';
import { authorizeCarriedWrites } from '../establishment/carried-transfer.js';
import { EMPLOYMENT_OBJECT, requireLinkedEmploymentRecord } from '../employment/context.js';
import { findCurrentRecord } from '../employment/read-model.js';
import type { EmploymentContext } from '../employment/types.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { requireTransferSource } from '../transfer/access.js';
import {
  authorizeContractChange,
  authorizeLinkageWrite,
  authorizeOrgRole,
  authorizeSubordinateField,
  type LinkageAccess,
} from '../transfer/linkage/access.js';
import type { LinkageOptions } from '../transfer/linkage/input.js';
import { normalizeLinkage } from '../transfer/linkage/input.js';
import { notEligible } from '../transfer/linkage/validation.js';
import { previewTransferChecked } from '../transfer/preview.js';
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

const dottedToken = (row: TransferContent | null) =>
  row?.dottedManagerSpecified ? (row.dottedManagerId ?? null) : undefined;

/** 新旧内容里值不同的调动明细字段编码；新建时旧侧为空、删除时新侧为空，置空 / 置 false 同样算改动。 */
export function changedTransferFields(before: TransferContent | null, after: TransferContent | null) {
  const codes = new Set<string>();
  const [old, next] = [before as Record<string, unknown> | null, after as Record<string, unknown> | null];
  for (const [key, code] of Object.entries(FIELD_CODE)) {
    if (!same(old?.[key], next?.[key])) codes.add(code);
  }
  // 虚线经理“显式给 null（清空）”与“未给（继承表单）”是两种意图：清空也是在改写下属经理，不能按空值等同
  if (dottedToken(before) !== dottedToken(after)) codes.add(FIELD_CODE.dottedManagerId!);
  for (const [key, code] of Object.entries(LINKAGE_CODE)) {
    if (!same(before?.linkage?.[key as keyof LinkageOptions], after?.linkage?.[key as keyof LinkageOptions])) {
      codes.add(code);
    }
  }
  return Object.fromEntries([...codes].map((code) => [code, null]));
}

/** 谁在写：申请人 / 提交走编辑明细按钮；当前审批人（审批中编辑）只取 `EditApprovalIngApply@detail`（§6.3 不再逐入口判）。 */
export type TransferActor = 'applicant' | 'current_approver';

interface Env {
  readonly deps: TransferAuthorityDeps;
  readonly base: TenantContext;
  readonly button: typeof HEAD_BUTTONS.update | typeof HEAD_BUTTONS.approve;
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

/**
 * 合同联动（第 3 轮 P1-2a）：新旧任一侧有合同，就独立复核新旧目标合同的范围、变动字段与“变更”按钮——
 * 不论联动内容有没有差异（保留合同只改部门，也要在“变更”按钮、合同范围收窄后拒绝）。
 */
async function authorizeContractSides(
  tx: Tx,
  ctx: EmploymentContext,
  access: LinkageAccess,
  employeeId: string,
  before: LinkageOptions | null,
  after: LinkageOptions | null,
) {
  if (!before?.contract && !after?.contract) return;
  await authorizeContractChange(tx, ctx, access, employeeId, before?.contract ?? null, after?.contract ?? null);
}

/**
 * 职责转交下属（第 3 轮 P1-2b、第 4 轮 P2-1）：新旧选项里出现的每个下属，当前任职都要在操作人任职范围内
 * （与人工转交同一个 requireLinkedEmploymentRecord；范围外 404 LINKED_RECORD_OUT_OF_SCOPE，不探测原因）。
 * 查不到现行任职不能跳过：与直接调动（transfer/linkage/validation requireReportingSubordinate）同口径，
 * 没有任职 / 已离职一律 400 TRANSFER_PERSON_NOT_ELIGIBLE，否则无任职下属能绕过范围复核落进执行器。
 */
async function authorizeDutySubordinates(tx: Tx, ctx: EmploymentContext, ...sides: (LinkageOptions | null)[]) {
  const ids = new Set(sides.flatMap((side) => side?.dutyTransfer?.subordinates.map((item) => item.employeeId) ?? []));
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  for (const id of ids) {
    const record = await findCurrentRecord(tx, ctx.tenantId, id, today);
    if (!record) throw notEligible();
    await requireLinkedEmploymentRecord(tx, ctx, id, record.fields.departmentId, record.id);
  }
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
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const candidates = await carriedCandidates(tx, capacity, orgIds, view.effectiveDate, today);
  await authorizeCarriedWrites(tx, capacity, candidates, today);
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
  touched: Readonly<Record<string, null>> = {},
) {
  await authorizeItem(tx, env.deps, env.base, {
    button: [OBJECT, ...env.button],
    subjectOrgId: view.approvalSubjectOrgId,
    orgIds: [before?.departmentId, after?.departmentId],
  });
  await requireObjectWrite(ctx.authorize!, env.base, {
    objectCode: OBJECT,
    operation: 'update',
    payload: { ...changedTransferFields(before, after), ...touched },
  });
  const access = await linkageAccess(tx, env, ctx, before?.linkage, after?.linkage);
  await authorizeOldDuty(tx, ctx, access, before?.linkage ?? null);
  await authorizeContractSides(tx, ctx, access, employeeId, before?.linkage ?? null, after?.linkage ?? null);
  await authorizeDutySubordinates(tx, ctx, before?.linkage ?? null, after?.linkage ?? null);
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
  touched?: Readonly<Record<string, null>>,
) {
  assertLinkageSupported(draft.linkage);
  const ctx = await employment(tx, env);
  const access = await authorizeChange(tx, env, view, ctx, employeeId, before, draft, touched);
  const input = await normalizeTransferInput(tx, ctx, transferRaw(view.effectiveDate, draft));
  await requireTransferSource(tx, ctx, employeeId, INITIATOR);
  await requireTransferWrite(ctx, input);
  // 目标部门是同单新增组织时没有正式 ID：预览只判已选的部门（未选部门的场景表单允许预览）
  const preview = await previewTransferChecked(tx, ctx, employeeId, input);
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

export function transferGate(
  deps: TransferAuthorityDeps,
  base: TenantContext,
  actor: TransferActor = 'applicant',
): TransferGate {
  const env: Env = { deps, base, button: actor === 'applicant' ? HEAD_BUTTONS.update : HEAD_BUTTONS.approve };
  return {
    save: (tx, view, employeeId, draft, before) => saveRow(tx, env, view, employeeId, draft, before),
    remove: (tx, view, row) => removeRow(tx, env, view, row),
    /** 提交 / 重提：库里的行按新建口径（before = null）再判；保存类重放带上台账里的变更前的行，新旧两侧都判。 */
    async rejudge(tx, view, rows, previous) {
      for (const [index, row] of rows.entries()) {
        await saveRow(tx, env, view, row.employeeId, row, previous?.[index] ?? null);
      }
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

/** 审批人编辑一行时用于授权的新旧两侧（首次编辑时的整行，存在命令台账里供重放重判）。 */
export interface ApproverEditRecord {
  readonly before: TransferItem;
  readonly after: TransferItem;
}

/**
 * 审批中编辑的同键重放（第 3 轮 P2-1、第 4 轮 P2-2）：行已按首次编辑落库，所以按命令台账里记下的首次新旧两侧，
 * 用审批人当前权限（`EditApprovalIngApply`、字段写权、范围、联动与带编）逐侧再判一遍，不重写。
 * 不能拿当前行同时当新旧两侧：首次取消带编后，旧侧的带编编制权会在重放里被漏判。
 */
export async function rejudgeApproverEdits(
  tx: Tx,
  deps: TransferAuthorityDeps,
  base: TenantContext,
  view: AdjustmentView,
  edits: readonly ApproverEditRecord[],
): Promise<void> {
  const env: Env = { deps, base, button: HEAD_BUTTONS.approve };
  for (const { before, after } of edits) await saveRow(tx, env, view, after.employeeId, after, before);
}
