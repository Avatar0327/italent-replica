/**
 * 任职 / 离退类审批的“内容源”（F-476 P4，设计 §5.4）：三个人事详情入口（任职业务 / 离职 / 退休）共用这一份对象。
 * - 办理时冻结 `loadEmploymentContent` 的结果（办理份 ext）：业务内容 = 详情里除“流程事实”以外的全部键；
 *   流程事实（状态、版本号、生效结果、动作、日志等）始终读现值，不进办理份，也不会被办理份盖掉。
 * - 已办读取：现值里只留流程事实，业务内容全部取自冻结份，再按披露集合（办理时上限 ∩ 办理节点表单 ∩ 当前权限）取舍——
 *   办理份里没有的内容键或不在披露集合里的键一律缺席，不退回现值（DEC-807）。
 * - 内容键对应的审批字段编码：fields.X / customFields.X / 扩展字段 X 就是 X；名称类派生键跟随其编码；
 *   不属于审批表单的键（试用期、加黑原因等）没有编码，已办读取不披露。
 */
import { withTenant, type Tx } from '@italent/db';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { approvalError } from '../approval/context.js';
import { disclosedFields } from '../approval/disclosure.js';
import { foreignVisibility, viewableWithForeign } from '../approval/foreign-fields.js';
import { contentViewOf, type ContentSelection } from '../approval/handling-content.js';
import { latestInstanceOf } from '../approval/store.js';
import { openDetail } from '../org-adjustment/disclosure.js';
import { authorizeInTransaction, getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { loadExitDetail } from './exit-queries.js';
import { loadEmploymentBusiness } from './read-model.js';
import { loadRetirementDetail } from './retirement-views.js';

type Row = Record<string, unknown>;

/** 任职业务详情里的流程事实（读现值）；其余键都是业务内容。 */
const BUSINESS_FACTS: ReadonlySet<string> = new Set([
  'id',
  'employeeId',
  'revision',
  'employeeRevision',
  'status',
  'kind',
  'mode',
  'formId',
  'employeeStatus',
  'entryStatus',
  'record',
  'activation',
]);

/** 离职 / 退休详情里的流程事实（读现值）：身份、状态、动作、生效 / 撤销结果、版本与事件、下游执行结果。 */
const EXIT_FACTS: ReadonlySet<string> = new Set([
  'id',
  'employeeId',
  'code',
  'name',
  'departmentId',
  'positionId',
  'status',
  'actions',
  'mode',
  'initiator',
  'initiatorUserId',
  'batchId',
  'revision',
  'createdAt',
  'activation',
  'cancellation',
  'versions',
  'events',
  'approvalInstanceId',
  'effects',
  'dutyTransfer',
]);

/** 名称类派生键跟随的审批字段。 */
const EXIT_CODE_OF: Readonly<Record<string, string>> = {
  exitTypeName: 'exitTypeCode',
  reasonName: 'reasonCode',
  whereaboutsName: 'whereaboutsCode',
};

export interface EmploymentContent {
  readonly business: Row;
  /** 离职单 / 退休单的专用详情内容；其他类型为 null。 */
  readonly exit: Row | null;
}

const contentOf = (source: Row, facts: ReadonlySet<string>): Row =>
  Object.fromEntries(Object.entries(source).filter(([key]) => !facts.has(key)));

/** 读全任职业务的内容现值（办理时冻结的 ext）；业务不存在返回 null。 */
export async function loadEmploymentContent(
  tx: Tx,
  tenantId: string,
  businessId: string,
): Promise<EmploymentContent | null> {
  // 业务内容不随查询日期变化；asOf 只影响生效后的“当前记录”，那属于流程事实、不进办理份
  const business = await loadEmploymentBusiness(tx, tenantId, businessId, new Date().toISOString().slice(0, 10));
  if (!business) return null;
  const exit =
    business.kind === 'leave'
      ? await loadExitDetail(tx, tenantId, businessId, undefined)
      : business.kind === 'retirement'
        ? await loadRetirementDetail(tx, tenantId, businessId, undefined)
        : null;
  return {
    business: contentOf(business as unknown as Row, BUSINESS_FACTS),
    exit: exit ? contentOf(exit as unknown as Row, EXIT_FACTS) : null,
  };
}

const pickCodes = (source: unknown, allowed: ReadonlySet<string>): Row =>
  Object.fromEntries(Object.entries((source ?? {}) as Row).filter(([code]) => allowed.has(code)));

/** 已办读取：现值只留流程事实，业务内容全部取自冻结份且只留披露集合内的键。 */
function compose(
  live: Row,
  frozen: Row,
  facts: ReadonlySet<string>,
  codeOf: (key: string) => string | null,
  allowed: ReadonlySet<string>,
): Row {
  const result: Row = Object.fromEntries(Object.entries(live).filter(([key]) => facts.has(key)));
  for (const [key, value] of Object.entries(frozen)) {
    if (key === 'fields' || key === 'customFields') result[key] = pickCodes(value, allowed);
    else {
      const code = codeOf(key);
      if (code !== null && allowed.has(code)) result[key] = value;
    }
  }
  return result;
}

export const composeBusiness = (live: object, content: EmploymentContent, allowed: ReadonlySet<string>): Row =>
  compose(live as Row, content.business, BUSINESS_FACTS, (key) => (key === 'effectiveDate' ? key : null), allowed);

/** 离职 / 退休单没有对应冻结内容（办理的是别的类型）时返回 null，调用方按原样 404。 */
export const composeExit = (live: object, content: EmploymentContent, allowed: ReadonlySet<string>): Row | null =>
  content.exit ? compose(live as Row, content.exit, EXIT_FACTS, (key) => EXIT_CODE_OF[key] ?? key, allowed) : null;

export interface EmploymentRead {
  readonly contentView: ReturnType<typeof contentViewOf> | { mode: 'live'; instanceId: null };
  /** 已办读取：冻结内容与披露集合；现值读取为 null。 */
  readonly frozen: { readonly content: EmploymentContent; readonly allowed: ReadonlySet<string> } | null;
}

/**
 * 选内容来源：本人有待办 / 是发起人 / 没办理过 → 现值；本人最近一次办理 → 冻结份（缺份 503）。
 * 调用方已通过原有的人事读权限与数据范围，这里只决定“读哪一份内容”。
 */
export async function selectEmploymentRead(
  deps: TenantRouteDeps,
  ctx: TenantContext,
  businessId: string,
): Promise<EmploymentRead> {
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const instance = await latestInstanceOf(tx, ctx.tenantId, 'employment', businessId);
    if (!instance) return { contentView: { mode: 'live', instanceId: null }, frozen: null } as const;
    const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
    const data = await openDetail(tx, bound, ctx, instance, false);
    const selection: ContentSelection = data?.content ?? { mode: 'live' };
    const contentView = contentViewOf(instance.id, selection);
    if (!data || selection.mode === 'live') return { contentView, frozen: null };
    const content = selection.frozen.content.ext as EmploymentContent | null;
    // 改造前写下的办理份没有 ext：同样失败闭合，不拿现值顶替（DEC-807；不做旧数据兼容，DEC-402）
    if (!content) {
      throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_HANDLING_CONTENT_MISSING', '办理记录暂不可读取，请稍后重试');
    }
    const own = await getModuleViewableFieldsInTransaction(bound, ctx, data.snapshot.fieldObjectCode, tx);
    const viewable = await viewableWithForeign(data.snapshot, own, foreignVisibility(bound, ctx, tx));
    return { contentView, frozen: { content, allowed: disclosedFields(data, ctx.userId, viewable) } };
  });
}
