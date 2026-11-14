/**
 * 组织调整预览 / 导出的“冻结输入”（F-476 P2，设计 §5.4、§8）：预览树只依赖调整范围子树里每个组织在生效日的
 * 几个属性（编码、名称、行政上级与顺序号、负责人、编制原值）和负责人姓名，本文件把它们一次读全，随办理份冻结。
 * 已办读者的预览 / 导出是这份输入加本单明细的纯投影（`preview.ts` 的 `previewOf`），不再回头读组织、人员、编制现值，
 * 所以办理之后改组织名称、换负责人、改上级、增删明细都不会让它漂移（AC-F476-12）。
 * 这里是未按查看人裁剪的完整输入；披露裁剪（范围、字段）在投影时做，与现值读同一套代码。
 */
import { and, employmentEmployees, eq, inArray, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { batchLocalSums } from '../establishment/capacity-read.js';
import { DEFAULT_SCHEME_CODE } from '../establishment/default-scheme.js';
import { loadSchemeBatch } from '../establishment/schemes.js';
import { loadOrgSnapshot, rowsOf, type OrgRecord } from '../org/read-model.js';
import { currentPersonName } from '../personnel/employee-projection.js';
import type { OrgItem } from './items-store.js';

/** 预览树里一个既有组织在生效日的属性（行政维度）。 */
export interface PreviewOrg {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** 行政上级；子树根的上级可能在子树之外。 */
  readonly parentId: string | null;
  readonly sequence: number | null;
  readonly personInChargeId: string | null;
  /** 编制原值（含下级）；没有编制为 null。 */
  readonly establishment: number | null;
}

/** 与组织明细分区同量级的防御上限：超过时 413，不返回截断的树（截断会误导为“没有调整”）。DEC-728。 */
export const PREVIEW_NODE_LIMIT = 2000;

/** 预览预算的唯一判断：现值读（previewOf 的结果树）与办理时冻结（loadPreviewInput）共用，口径不会分叉。 */
export const exceedsPreviewLimit = (nodes: number): boolean => nodes > PREVIEW_NODE_LIMIT;

export const previewTooLarge = () =>
  new AppError('PAYLOAD_TOO_LARGE', `预览节点超过 ${PREVIEW_NODE_LIMIT} 个，请缩小调整范围`);

/**
 * 读预览输入的方式：
 * - live：现值读（发起人 / HR 等在办读者），读全子树；读者受范围裁剪时看到的可能不足 2000 个节点，所以不能提前拒绝。
 * - freeze：办理时冻结（审批人按办理时视角无范围裁剪，预览节点数就是子树大小）。超限的子树读它只会得到 413，
 *   整棵树存进办理份既没人读得到，又会让原本合法的大范围单据在办理时撞 16 MiB 上限或编制汇总预算而失败
 *   （设计 §3.5），所以只记“读它会得到什么错误”，体积有界。
 */
export type PreviewLoad = 'live' | 'freeze';

/** 冻结时就已确定读不出来的预览：读取时按记下的错误原样返回，与现值读同码同文案。 */
export interface PreviewRefused {
  readonly kind: 'refused';
  readonly code: 'PAYLOAD_TOO_LARGE' | 'SERVICE_UNAVAILABLE';
  readonly message: string;
}

export type PreviewInput = PreviewTree | PreviewRefused;

export interface PreviewTree {
  readonly kind: 'tree';
  /** 调整范围所选组织及其全部在用下级（生效日行政树）。 */
  readonly orgs: readonly PreviewOrg[];
  /** 员工 ID → 人员版本链最新姓名（子树组织的负责人与明细指定的负责人）。 */
  readonly heads: Readonly<Record<string, string>>;
}

/** 调整范围所选组织及其全部在用下级（行政维度）；所选组织之间互为上下级时只算一次。 */
export function rangeSubtree(orgs: ReadonlyMap<string, OrgRecord>, range: readonly string[]): OrgRecord[] {
  const children = new Map<string, string[]>();
  for (const org of orgs.values()) {
    const parentId = org.parents.admin?.parentId;
    if (org.enabled === false || !parentId) continue;
    // 就地追加：同一上级下万级下级时，每次复制整个数组是 O(N²)（F-476 P2 第 4 轮量测）
    const siblings = children.get(parentId);
    if (siblings) siblings.push(org.id);
    else children.set(parentId, [org.id]);
  }
  const result = new Set<string>();
  const queue = range.filter((id) => orgs.get(id)?.enabled !== false && orgs.has(id));
  // 下标走队列：shift() 在大数组上每次 O(n)；也不用 push(...大数组)，参数个数过万会撞调用栈上限
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    if (result.has(id)) continue;
    result.add(id);
    for (const child of children.get(id) ?? []) queue.push(child);
  }
  return [...result].map((id) => orgs.get(id)!);
}

/** 读预览输入；`effectiveDate` 是单据生效日，`range` 是调整范围组织（按选择顺序）。 */
export async function loadPreviewInput(
  tx: Tx,
  tenantId: string,
  effectiveDate: string,
  range: readonly string[],
  items: readonly OrgItem[],
  load: PreviewLoad,
): Promise<PreviewInput> {
  const snapshot = await loadOrgSnapshot(tx, tenantId, effectiveDate);
  const subtree = rangeSubtree(new Map(snapshot.map((org) => [org.id, org])), range);
  const subtreeIds = subtree.map((org) => org.id);
  // 错误优先级与现值读一致：现值读先读编制（汇总预算 503），读完才在投影里数节点（413），所以冻结也先判编制。
  let establishment: Map<string, number | null>;
  try {
    establishment = await establishmentByOrg(tx, tenantId, effectiveDate, subtreeIds);
  } catch (error) {
    // 编制汇总范围（含已停用 / 未启用但未到期的下级）超预算时现值读是 503；冻结时同样记下，不让办理因此失败
    if (load !== 'freeze' || !(error instanceof AppError) || error.code !== 'SERVICE_UNAVAILABLE') throw error;
    return { kind: 'refused', code: 'SERVICE_UNAVAILABLE', message: error.message };
  }
  if (load === 'freeze' && exceedsPreviewLimit(subtree.length)) {
    const error = previewTooLarge();
    return { kind: 'refused', code: error.code as PreviewRefused['code'], message: error.message };
  }
  const orgs = subtree.map((org) => ({
    id: org.id,
    code: org.code,
    name: org.name,
    parentId: org.parents.admin?.parentId ?? null,
    sequence: org.parents.admin?.sequence ?? null,
    personInChargeId: org.personInChargeId,
    establishment: establishment.get(org.id) ?? null,
  }));
  const headIds = [...orgs.map((org) => org.personInChargeId), ...items.map((item) => item.personInChargeId)];
  return { kind: 'tree', orgs, heads: Object.fromEntries(await headNames(tx, tenantId, headIds)) };
}

/** 负责人姓名与组织详情、人员档案同口径：人员版本链的最新姓名（任职头表的姓名不随改名更新）；一次批量查询。 */
export async function headNames(tx: Tx, tenantId: string, candidates: readonly (string | null)[]) {
  const names = new Map<string, string>();
  const ids = [...new Set(candidates.filter((id): id is string => !!id))];
  if (!ids.length) return names;
  const name = currentPersonName(tenantId, sql`${employmentEmployees.id}`, sql`${employmentEmployees.name}`);
  const rows = await tx
    .select({ id: employmentEmployees.id, name: sql<string>`${name}` })
    .from(employmentEmployees)
    .where(and(eq(employmentEmployees.tenantId, tenantId), inArray(employmentEmployees.id, ids)));
  for (const row of rows) names.set(row.id, row.name);
  return names;
}

interface CapacityRow {
  objectId: string;
  orgId: string;
  schemeId: string;
  periodStart: string;
  inclusive: number | null;
}

/**
 * 编制原值：生效日所在周期的编制；兜底场景下同一组织有多个方案时按 `pickScheme` 取一个。
 * “仅本级”方案的含下级直接用编制详情的 `batchLocalSums`（同一汇总类型与子树预算）。
 * 没有编制的组织不在结果里。架构图卡片（F-474-2b）与调整预览共用。
 */
export async function establishmentByOrg(tx: Tx, tenantId: string, date: string, orgIds: readonly string[]) {
  const result = new Map<string, number | null>();
  if (!orgIds.length) return result;
  const rows = rowsOf<CapacityRow>(
    await tx.execute(sql`SELECT o.id::text AS "objectId", o.org_id::text AS "orgId", o.scheme_id::text AS "schemeId",
        o.period_start::text AS "periodStart", v.inclusive_capacity AS inclusive
      FROM establishment_objects o
      JOIN LATERAL (SELECT inclusive_capacity FROM establishment_versions v
        WHERE v.tenant_id = o.tenant_id AND v.object_id = o.id AND v.start_date <= ${date}::date
        ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1) v ON true
      WHERE o.tenant_id = ${tenantId} AND o.org_id = ANY(${`{${orgIds.join(',')}}`}::uuid[])
        AND o.period_start <= ${date}::date AND o.period_end >= ${date}::date`),
  );
  const schemes = new Map(
    (await loadSchemeBatch(tx, tenantId, [...new Set(rows.map((r) => r.schemeId))], date)).map((s) => [s.id, s]),
  );
  const byOrg = new Map<string, (CapacityRow & SchemeKey)[]>();
  for (const row of rows) {
    const scheme = schemes.get(row.schemeId);
    if (!scheme) continue;
    const list = byOrg.get(row.orgId) ?? [];
    list.push({ ...row, code: scheme.code, enabled: scheme.enabled });
    byOrg.set(row.orgId, list);
  }
  const chosen = new Map<string, CapacityRow>();
  for (const [orgId, list] of byOrg) {
    const row = pickScheme(list);
    if (row) chosen.set(orgId, row);
  }
  const local = [...chosen.values()].filter((row) => schemes.get(row.schemeId)!.maintenanceMode === 'local');
  const sums = await batchLocalSums(
    tx,
    tenantId,
    local.map((row) => ({ ...row, id: row.objectId })),
    date,
  );
  for (const [orgId, row] of chosen) result.set(orgId, sums.get(row.objectId) ?? row.inclusive);
  return result;
}

interface SchemeKey {
  readonly code: string;
  readonly enabled: boolean;
}

/**
 * 同一组织在生效日有多个方案的编制时选哪一个（F-446，北森实测，DEC-784）：
 * - 北森同一组织在重叠周期内只能有一个方案的编制（新建时前端即拦），不同年份 / 不重叠周期的方案可并存（如某年度方案
 *   与另一年的月度方案）；预览取生效日所在周期的那一条（上面查询的 period_start / period_end 条件已做到），
 *   不存在“同期多方案取哪个”的业务情形。
 * - 北森停用被当前 / 未来周期编制引用的方案会被直接拒绝；复刻同口径（schemes.ts 的 SCHEME_IN_USE，提示照北森原文），
 *   所以生效日所在周期的编制不会指向已停用方案；组织没有编制时显示“--”，与北森一致。
 * 复刻写入侧已按同口径拦截（F-484，DEC-279① / DEC-295①，capacity-overlap.ts）：同一组织任一方案的编制与新周期
 * 按月份区间重叠即拒绝，所以新数据里同期多方案不会出现；这里保留确定性兜底（防御用）：先排除已停用方案；
 * 启用方案里预置默认方案（DEFAULT_SCHEME_CODE）优先；
 * 其余按方案编码升序取第一个。结果与录入顺序无关。
 */
export function pickScheme<T extends SchemeKey>(candidates: readonly T[]): T | null {
  const rank = (row: T) => (row.code === DEFAULT_SCHEME_CODE ? 0 : 1);
  const enabled = candidates.filter((row) => row.enabled);
  // 按 UTF-16 码元比较编码，结果不随区域设置变化
  const byCode = (a: T, b: T) => Number(a.code > b.code) - Number(a.code < b.code);
  enabled.sort((a, b) => rank(a) - rank(b) || byCode(a, b));
  return enabled[0] ?? null;
}
