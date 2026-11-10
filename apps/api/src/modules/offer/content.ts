/**
 * Offer 单 / Offer 批的办理时扩展内容（F-476 P6，设计 §3、§5.4）。
 * 办理份里 snapshot 已冻结 Offer 的表单值与批的成员行（成员、顺序、取值都在 snapshot 里，不从当前成员表重建）；
 * 这里补的是「办理时看到的显示标签」（录用部门 / 岗位 / 直接上级等名称）与「批行内列的披露上限」：
 * - 标签只为办理人当时有权查看来源字段的列捕获，名称与来源 ID 同进同出（撤权后一起裁，新增权限不补露）；
 * - 批行内列属于 Offer 对象的字段，披露上限是办理人对 Offer 对象的字段权（与批表单字段权是两套授权）；
 * - 系统份没有办理人：viewableOf 一律空集，不捕获标签（也没有任何读者）；
 * - 审批中心还会给部门 / 直接上级 / 虚线上级附 `<字段>Name`：办理时一并冻结（refs），读取时由冻结值占位，
 *   不再按当前名称补（部门改名后旧份仍是办理时的名称）；
 * - 标签与引用名在**同一条语句**里读（captureNames，设计 §4.3）：名称表不加业务锁，分几条语句读会混入不同时刻的
 *   新旧名称（评审 P2-2）。口径分别与列表详情的 withOfferNames、审批中心的 referenceNames 一致。
 * 缺来源内容不写空对象冒充已冻结：Offer 已不存在时直接失败（DEC-807）。
 */
import { OFFER_NAME_FIELDS, OFFER_OBJECT, tenantLocalDate } from '@italent/domain';
import { sql, type Tx } from '@italent/db';
import type { Run } from '../approval/engine.js';
import { approvalError, rowsOf, type ApprovalContext } from '../approval/context.js';
import type { HandlerFacts } from '../approval/handling-content.js';
import { personnelHooks } from '../employment/personnel-hooks.js';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type NameKind = 'department' | 'position' | 'post' | 'person' | 'sender';
/** name = 列表详情口径的标签；full = 部门全称；ref = 审批中心引用名口径（部门须当天未停用且对象仍在，人员取人事现名）。 */
interface NameRow {
  readonly kind: NameKind;
  readonly id: string;
  readonly name: string | null;
  readonly full: string | null;
  readonly ref: string | null;
}

const jobNames = (kind: NameKind, table: string, tenantId: string, ids: string, today: string) =>
  sql`(SELECT DISTINCT ON (object_id) ${kind}::text, object_id::text, name::text, NULL::text, NULL::text
    FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId} AND object_id = ANY(${ids}::uuid[])
      AND start_date <= ${today}::date ORDER BY object_id, start_date DESC, version_no DESC)`;

/** 一条语句读出全部名称（同一快照）：部门 / 岗位 / 职务按租户今天的现行版本，人员、发送人按当前名称。 */
async function captureNames(tx: Tx, ctx: Run['ctx'], dtos: readonly Dto[]) {
  const ids = (...fields: string[]) =>
    `{${[...new Set(dtos.flatMap((row) => fields.map((field) => row[field])))]
      .filter((v): v is string => typeof v === 'string' && UUID.test(v))
      .join(',')}}`;
  const { tenantId } = ctx;
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const rows = rowsOf<NameRow>(
    await tx.execute(sql`(SELECT DISTINCT ON (v.org_id) 'department'::text AS kind, v.org_id::text AS id,
        v.name::text AS name, v.full_name::text AS full,
        CASE WHEN v.stop_date >= ${today}::date AND EXISTS (SELECT 1 FROM org_objects o
          WHERE o.tenant_id = v.tenant_id AND o.id = v.org_id) THEN v.name::text END AS ref
      FROM org_versions v WHERE v.tenant_id = ${tenantId} AND v.org_id = ANY(${ids('departmentId')}::uuid[])
        AND v.start_date <= ${today}::date ORDER BY v.org_id, v.start_date DESC, v.version_no DESC)
      UNION ALL ${jobNames('position', 'job_position_versions', tenantId, ids('positionId'), today)}
      UNION ALL ${jobNames('post', 'job_post_versions', tenantId, ids('postId'), today)}
      UNION ALL SELECT 'person', e.id::text, e.name::text, NULL,
        (${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)})::text
      FROM employment_employees e WHERE e.tenant_id = ${tenantId}
        AND e.id = ANY(${ids('directManagerId', 'dottedManagerId')}::uuid[])
      UNION ALL SELECT 'sender', account_id::text, display_name::text, NULL, NULL
      FROM tenant_member_accounts(${ids('sentBy')}::uuid[])`),
  );
  const byKey = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row]));
  return (kind: NameKind, id: unknown) => (typeof id === 'string' ? byKey.get(`${kind}:${id}`) : undefined);
}

/** 列表详情口径的标签（与 withOfferNames 同名同义）。 */
function labelsOf(row: Dto, name: Awaited<ReturnType<typeof captureNames>>): Dto {
  return {
    ...row,
    departmentName: name('department', row.departmentId)?.name ?? null,
    departmentFullName: name('department', row.departmentId)?.full ?? null,
    positionName: name('position', row.positionId)?.name ?? null,
    postName: name('post', row.postId)?.name ?? null,
    directManagerName: name('person', row.directManagerId)?.name ?? null,
    sentByName: name('sender', row.sentBy)?.name ?? null,
  };
}

/** 审批中心引用名的来源种类（与 referenceNames 的部门 / 人员键一致）。 */
const REF_KINDS: Readonly<Record<RefKey, NameKind>> = {
  departmentIdName: 'department',
  directManagerIdName: 'person',
  dottedManagerIdName: 'person',
};

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
  _ctx: ApprovalContext,
  run: Run,
  handler: HandlerFacts,
): Promise<OfferContent> {
  // Offer 不存在时适配器把快照降级为 revision:0 的空表单：这种内容不能冒充办理时的整份
  if (run.snapshot.version === 'revision:0') {
    throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_CONTENT_SOURCE_MISSING', 'Offer 已不存在，无法保存办理记录');
  }
  const values = run.snapshot.values;
  const name = await captureNames(tx, run.ctx, [values]);
  const refs: Partial<Record<RefKey, string | null>> = {};
  for (const [key, source] of Object.entries(REF_NAME_SOURCES) as [RefKey, string][]) {
    if (handler.viewable && !handler.viewable.has(source)) continue;
    if (typeof values[source] !== 'string') continue;
    refs[key] = name(REF_KINDS[key], values[source])?.ref ?? null;
  }
  return { labels: visibleLabels(labelsOf(values, name), handler.viewable), refs };
}

/** Offer 批：行取自已冻结的 snapshot.values.offers（办理时成员与顺序），再按办理人的 Offer 字段权补标签。 */
export async function loadOfferBatchContent(
  tx: Tx,
  _tenantId: string,
  _businessId: string,
  _ctx: ApprovalContext,
  run: Run,
  handler: HandlerFacts,
): Promise<OfferBatchContent> {
  const rows = (run.snapshot.values.offers ?? []) as readonly Dto[];
  const ceiling = await handler.viewableOf(OFFER_OBJECT);
  const name = await captureNames(tx, run.ctx, rows);
  return {
    rowCeiling: ceiling ? [...ceiling].sort() : null,
    rows: rows.map((row) => ({
      offerId: String(row.offerId),
      labels: visibleLabels(labelsOf(row, name), ceiling, BATCH_ROW_LABEL_KEYS),
    })),
  };
}
