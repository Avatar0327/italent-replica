/**
 * Offer 单 / Offer 批的办理时扩展内容（F-476 P6，设计 §3、§5.4）。
 * 办理份里 snapshot 已冻结 Offer 的表单值与批的成员行（成员、顺序、取值都在 snapshot 里，不从当前成员表重建）；
 * 这里补的是「办理时看到的显示标签」（录用部门 / 岗位 / 直接上级等名称）与「批行内列的披露上限」：
 * - 标签只为办理人当时有权查看来源字段的列捕获，名称与来源 ID 同进同出（撤权后一起裁，新增权限不补露）；
 * - 批行内列属于 Offer 对象的字段，披露上限是办理人对 Offer 对象的字段权（与批表单字段权是两套授权）；
 * - 系统份没有办理人：viewableOf 一律空集，不捕获标签（也没有任何读者）；
 * - 审批中心还会给部门 / 直接上级 / 虚线上级附 `<字段>Name`：办理时用同一个取名函数一并冻结（refs），
 *   读取时由冻结值占位，不再按当前名称补（部门改名后旧份仍是办理时的名称）。
 * 缺来源内容不写空对象冒充已冻结：Offer 已不存在时直接失败（DEC-807）。
 */
import { OFFER_NAME_FIELDS, OFFER_OBJECT } from '@italent/domain';
import type { Tx } from '@italent/db';
import type { Run } from '../approval/engine.js';
import { approvalError } from '../approval/context.js';
import { referenceNames } from '../approval/reference-names.js';
import type { HandlerFacts } from '../approval/handling-content.js';
import { withOfferNames } from './read-names.js';

/** 显示标签键 → 来源字段（OFFER_NAME_FIELDS：departmentName → departmentId 等）。 */
export type LabelKey = keyof typeof OFFER_NAME_FIELDS;
export type Labels = Readonly<Partial<Record<LabelKey, string | null>>>;

/** 单个 Offer 的办理时扩展：只含办理人可见来源字段对应的标签。 */
export interface OfferContent {
  readonly labels: Labels;
  /** 审批中心引用名（departmentIdName 等）：同样只含办理人可见来源字段的。 */
  readonly refs: Readonly<Partial<Record<RefKey, string | null>>>;
}

/** 审批中心按来源 ID 附名称的键（reference-names.ts 的部门 / 人员键 + Name）。 */
export const REF_NAME_SOURCES = {
  departmentIdName: 'departmentId',
  directManagerIdName: 'directManagerId',
  dottedManagerIdName: 'dottedManagerId',
} as const;
export type RefKey = keyof typeof REF_NAME_SOURCES;

/** 批行内的办理时标签（按 offerId 对应 snapshot.values.offers 里的行）。 */
export interface BatchRowLabels {
  readonly offerId: string;
  readonly labels: Labels;
}

/** Offer 批的办理时扩展：行内列的披露上限（Offer 对象字段）与各行标签。 */
export interface OfferBatchContent {
  /** 办理人当时可见的 Offer 对象字段；null = 不受字段权限约束。 */
  readonly rowCeiling: readonly string[] | null;
  readonly rows: readonly BatchRowLabels[];
}

const LABEL_KEYS = Object.keys(OFFER_NAME_FIELDS) as LabelKey[];
/** 批的子表只有录用部门、岗位两列带名称。 */
export const BATCH_ROW_LABEL_KEYS: readonly LabelKey[] = ['departmentName', 'positionName'];
type Dto = Readonly<Record<string, unknown>>;

/** 只保留办理人有权查看来源字段、且来源 ID 有值的标签：名称随 ID 同进同出。 */
function visibleLabels(
  named: Dto,
  viewable: ReadonlySet<string> | undefined,
  keys: readonly LabelKey[] = LABEL_KEYS,
): Labels {
  const labels: Partial<Record<LabelKey, string | null>> = {};
  for (const key of keys) {
    const source = OFFER_NAME_FIELDS[key];
    if (viewable && !viewable.has(source)) continue;
    if (typeof named[source] !== 'string') continue;
    const value = named[key];
    labels[key] = typeof value === 'string' ? value : null;
  }
  return labels;
}

/** 单个 Offer：标签取自办理那一刻已冻结的快照值（与 snapshot 同一读，不再另读 Offer）。 */
export async function loadOfferContent(
  tx: Tx,
  _tenantId: string,
  _businessId: string,
  run: Run,
  handler: HandlerFacts,
): Promise<OfferContent> {
  // Offer 不存在时适配器把快照降级为 revision:0 的空表单：这种内容不能冒充办理时的整份
  if (run.snapshot.version === 'revision:0') {
    throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_CONTENT_SOURCE_MISSING', 'Offer 已不存在，无法保存办理记录');
  }
  const [named] = await withOfferNames(tx, run.ctx, [run.snapshot.values]);
  const { form } = await referenceNames(tx, run.ctx, 'offer', { form: { values: { ...run.snapshot.values } } });
  const refs: Partial<Record<RefKey, string | null>> = {};
  for (const [key, source] of Object.entries(REF_NAME_SOURCES) as [RefKey, string][]) {
    if (handler.viewable && !handler.viewable.has(source)) continue;
    if (typeof form.values[source] !== 'string') continue;
    const value = form.values[key];
    refs[key] = typeof value === 'string' ? value : null;
  }
  return { labels: visibleLabels(named!, handler.viewable), refs };
}

/** Offer 批：行取自已冻结的 snapshot.values.offers（办理时成员与顺序），再按办理人的 Offer 字段权补标签。 */
export async function loadOfferBatchContent(
  tx: Tx,
  _tenantId: string,
  _businessId: string,
  run: Run,
  handler: HandlerFacts,
): Promise<OfferBatchContent> {
  const rows = (run.snapshot.values.offers ?? []) as readonly Dto[];
  const ceiling = await handler.viewableOf(OFFER_OBJECT);
  const named = await withOfferNames(tx, run.ctx, rows);
  return {
    rowCeiling: ceiling ? [...ceiling].sort() : null,
    rows: named.map((row) => ({
      offerId: String(row.offerId),
      labels: visibleLabels(row, ceiling, BATCH_ROW_LABEL_KEYS),
    })),
  };
}
