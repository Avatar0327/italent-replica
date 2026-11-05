/**
 * 组织调整读接口的披露判定（R2-T08 §4.5“查看人 × 接口 × 字段”；BE-10d）。详情 / 明细 / 预览三个读接口共用
 * `orgAdjustmentDisclosure`，在同一租户事务内只判一次：
 * - HR：对象查看权 + 审批主体组织在 OrganizationApproval 范围；字段 = OrganizationApproval 字段查看权；明细行涉及的组织
 *   （目标、新上级、转移目标）逐个在组织对象范围，引用的本单明细也须可见，否则整行隐去，只计 hiddenRowCount。
 * - 可打开最新审批实例的人（审批人、发起人、抄送人、范围内的流程管理员）：字段 = 节点 formFields ∩ 字段查看权
 *   （`disclosedFieldNames`），不要求对象权限与组织范围，明细行全部可见。
 * - 两条都不通过：404，文案与不存在相同（F-339 同类：范围外与不存在不可区分）。
 * 审批人路径读审批中心同一份业务快照（BE-10c `readDetail`）并复用 `viewerNode` / `disclosedFields` 选节点（F-413），
 * 不在这里再拼一遍；快照随单据现值计算（审批中心同口径），披露集按查看人所在节点，不随之后的修改改变。
 */
import type { Tx } from '@italent/db';
import { APPROVAL_INSTANCE_OBJECT, buttonResource, MODULE_OBJECTS, ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { memberInstanceScope } from '../approval/access.js';
import { disclosedFields, readDetail, type DetailData } from '../approval/disclosure.js';
import { latestInstanceOf, type InstanceRow } from '../approval/store.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
  scopeAllows,
  type ModuleScope,
} from '../permission/module-access.js';
import type { OrgContent } from './content.js';
import type { OrgItem } from './items-store.js';
import { loadAdjustment, type AdjustmentView } from './service.js';

const OBJECT = ORG_ADJUSTMENT_OBJECT_CODE;
export const NOT_FOUND_MESSAGE = '组织调整申请不存在';

export interface Disclosure {
  readonly view: AdjustmentView;
  readonly via: 'hr' | 'approver';
  /** 可见字段编码；undefined = 不受字段权限约束（只在 HR 路径出现）。 */
  readonly fields: ReadonlySet<string> | undefined;
  /** HR 路径的组织对象范围；审批人路径为 null（不要求组织范围）。 */
  readonly orgScope: ModuleScope | null;
  readonly instanceId: string | null;
  /** 内容源：已办读办理时冻结份；null = 读现值（F-476 §5.4）。预览 / 导出本片仍只读现值。 */
  readonly source: OrgContent | null;
}

type Deps = Pick<TenantRouteDeps, 'authorize' | 'clock'>;

export function canSee(fields: ReadonlySet<string> | undefined, code: string): boolean {
  return fields === undefined || fields.has(code);
}

/**
 * 读接口共用的披露判定；不存在、范围外、不可打开实例都抛同一 404。
 * 先取审批参与上下文再按所选内容来源授权（F-476 §5.4）：本人已办且有办理份 → 读冻结份，走审批人路径（办理时的披露上限 ∩
 * 办理节点表单 ∩ 当前权限）；否则保持原顺序（HR → 审批人）读现值。缺份 503，不退回现值。
 * `live`：预览 / 导出（P2 才改）不做内容选择，行为与改动前一致。
 */
export async function orgAdjustmentDisclosure(tx: Tx, deps: Deps, ctx: TenantContext, id: string, live = false) {
  const view = await loadAdjustment(tx, ctx.tenantId, id);
  if (!view) throw notFound();
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const instance = await latestInstanceOf(tx, ctx.tenantId, 'org_adjustment', id);
  const data = instance ? await openDetail(tx, bound, ctx, instance, live) : null;
  if (instance && data?.content.mode === 'frozen') {
    const source = data.content.frozen.content.ext as OrgContent | null;
    if (!source) throw new AppError('SERVICE_UNAVAILABLE', '办理记录暂不可读取，请稍后重试');
    const viewable = await getModuleViewableFieldsInTransaction(bound, ctx, OBJECT, tx);
    const fields = disclosedFields(data, ctx.userId, viewable);
    return { view, via: 'approver', fields, orgScope: null, instanceId: instance.id, source } satisfies Disclosure;
  }
  const hr = await hrDisclosure(tx, bound, ctx, view);
  if (hr) return { ...hr, instanceId: instance?.id ?? null, source: null } satisfies Disclosure;
  if (instance && data) {
    const viewable = await getModuleViewableFieldsInTransaction(bound, ctx, OBJECT, tx);
    const fields = disclosedFields(data, ctx.userId, viewable);
    const opened: Disclosure = { view, via: 'approver', fields, orgScope: null, instanceId: instance.id, source: null };
    return opened;
  }
  throw notFound();
}

export function notFound() {
  return new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
}

async function hrDisclosure(tx: Tx, bound: Deps, ctx: TenantContext, view: AdjustmentView) {
  const request = { ...ctx, action: 'object.view', resource: OBJECT, fields: [] };
  if (!(await bound.authorize(request))) return null;
  const main = await resolveModuleScopeInTransaction(bound, ctx, tx, OBJECT);
  if (!scopeAllows(main, { orgId: view.approvalSubjectOrgId })) return null;
  const fields = await getModuleViewableFieldsInTransaction(bound, ctx, OBJECT, tx);
  const orgScope = await resolveModuleScopeInTransaction(bound, ctx, tx, MODULE_OBJECTS.organization.code);
  return { view, via: 'hr' as const, fields, orgScope };
}

/**
 * 审批中心同一判定（参与人或范围内的流程管理员）与同一份详情数据（含业务快照、查看人任务与抄送）；打不开返回 null。
 * 管理员范围在本事务内解析（PGlite 单连接）。
 */
async function openDetail(
  tx: Tx,
  bound: Deps,
  ctx: TenantContext,
  instance: InstanceRow,
  live: boolean,
): Promise<DetailData | null> {
  const adminScope = async (button: 'adminTransfer' | 'adminIntervene') => {
    const resource = buttonResource(APPROVAL_INSTANCE_OBJECT, button, 'detail');
    if (!(await bound.authorize({ ...ctx, action: 'object.button', resource }))) return null;
    return memberInstanceScope(bound as TenantRouteDeps, ctx, tx);
  };
  const viewer = {
    userId: ctx.userId,
    transferScope: await adminScope('adminTransfer'),
    interveneScope: await adminScope('adminIntervene'),
  };
  const command = { ...ctx, now: bound.clock(), commandId: '', expectedRevision: 0 };
  try {
    return await readDetail(tx, command, instance.id, viewer, false, live);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

/** 组织明细分区是否对查看人披露：至少一个 `orgItems.*` 字段可见。 */
export function orgSectionDisclosed(disclosure: Disclosure): boolean {
  const { fields } = disclosure;
  return fields === undefined || [...fields].some((field) => field.startsWith('orgItems.'));
}

/**
 * 明细行可见性（HR 路径）：行涉及的组织逐个在组织对象范围，引用的本单明细（新上级行、转移目标行、连带发起行）
 * 也须可见——按不动点收敛，隐藏行的名称不会经下级新增行的“上级”间接露出。审批人路径全部可见。
 */
export function visibleItems(disclosure: Disclosure, items: readonly OrgItem[]) {
  const scope = disclosure.orgScope;
  if (!scope) return { items: [...items], hiddenRowCount: 0 };
  const inScope = (orgId: string | null) => !orgId || scopeAllows(scope, { orgId });
  let visible = items.filter((item) => [item.targetOrgId, item.parentOrgId, item.transferToOrgId].every(inScope));
  for (;;) {
    const ids = new Set(visible.map((item) => item.id));
    const refOk = (ref: string | null) => !ref || ids.has(ref);
    const next = visible.filter((item) =>
      [item.parentItemId, item.transferToItemId, item.cascadedFromItemId].every(refOk),
    );
    if (next.length === visible.length) break;
    visible = next;
  }
  return { items: visible, hiddenRowCount: items.length - visible.length };
}
