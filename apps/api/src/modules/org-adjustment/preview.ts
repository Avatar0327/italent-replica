/**
 * 组织调整预览树（R2-T08 §6.2、§5.6、§4.5；DEC-644；F273A §4；BE-10d 路由 15）。
 * 生效日行政树只取调整范围所选组织及其下级（根按选择顺序），叠加本单明细：新建行以明细 ID 作虚拟节点（added），
 * 变更行标 changed 并按新上级挂接，停用行标 deactivated。已停用的组织不进树；暂存行不执行，不进预览。
 * 裁剪（§4.5）：HR 看不到的组织（组织对象范围外）不出节点，其可见下级挂到最近的可见祖先；被隐去的明细行不出节点
 * 也不改树；看不到的值给 null 并记入 masked。看不到新上级时节点不移动（变更）或放在根层（新建）。
 * 既有节点的属性（现名、负责人、编制原值）是调整范围的展开：调整范围可见，或节点是一条可见明细的目标（targetOrgId
 * 可见）时给出，否则给 null。HR 与审批人同一口径。看不到 `orgItems.name` 时保留现名，并在 masked 记 newName
 * （masked 含 name 则 name 一定为 null，F-442）。
 * 节点不带在岗 / 兼岗人数（DEC-745，照北森：调整预览各视图都没有人数，也没有调整前后对比，F273A §8.1）。
 * 负责人与“编制原值”（DEC-653，BE-10e 导出用）：
 * 负责人取生效日组织版本，可见的变更行给了新负责人时以明细为准，新增节点取明细值，姓名取人员版本链的最新姓名；
 * 编制原值口径同编制详情（readCapacity：覆盖生效日的期间、生效日版本的含下级编制，“仅本级”方案按启用子树汇总，
 * 复用 batchLocalSums），新增节点无编制；同期多方案属防御兜底，按 pickScheme 取一个。
 * 编制增减数随 11e / 11f 的编制生成行。
 * 同级顺序同组织模块（DEC-089）：行政顺序号（明细指定值优先，其次组织现值；空排最后）→ 编码 → 既有在前 → 录入顺序。
 * 改上级不填顺序号即沿用组织原顺序号（DEC-745，F273A §8.2）。
 */
import { and, employmentEmployees, eq, inArray, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { batchLocalSums } from '../establishment/capacity-read.js';
import { DEFAULT_SCHEME_CODE } from '../establishment/default-scheme.js';
import { loadSchemeBatch } from '../establishment/schemes.js';
import { currentPersonName } from '../personnel/employee-projection.js';
import { type OrgRecord, rowsOf } from '../org/read-model.js';
import { canSee, orgInScope, visibleItems, type Disclosure } from './disclosure.js';
import type { OrgItem } from './items-store.js';
import { loadWorld } from './item-tree.js';

/** 与组织明细分区同量级的防御上限：超过时 413，不返回截断的树（截断会误导为“没有调整”）。 */
export const PREVIEW_NODE_LIMIT = 2000;

type Mark = 'added' | 'changed' | 'deactivated';

export interface PreviewNode {
  readonly key: string;
  readonly orgId: string | null;
  readonly itemId: string | null;
  name: string | null;
  /** 负责人姓名；没有负责人或看不到时为 null。 */
  personInChargeName: string | null;
  /** 编制原值（含下级）；没有编制、本单新增或看不到时为 null。 */
  establishment: number | null;
  mark: Mark | null;
  masked: string[];
  children: PreviewNode[];
}

/** 同级排序键（DEC-089 组织模块同级排序）。 */
interface SortKey {
  /** 行政顺序号；null 排最后。 */
  sequence: number | null;
  code: string | null;
  /** 0 = 既有组织，1 = 本单新增。 */
  readonly added: 0 | 1;
  readonly tie: string;
}

interface Draft {
  readonly node: PreviewNode;
  /** 挂接目标：组织 ID 或明细 ID；null = 根层。 */
  parentKey: string | null;
  readonly sort: SortKey;
  /** 待解析姓名的负责人员工 ID。 */
  head: string | null;
}

const ATTR_FIELDS = ['personInChargeName', 'establishment'] as const;

const MARKS: Readonly<Record<OrgItem['adjustType'], Mark>> = { 1: 'added', 2: 'changed', 3: 'deactivated' };

export async function readPreview(tx: Tx, tenantId: string, disclosure: Disclosure) {
  const view = disclosure.view;
  const world = await loadWorld(tx, tenantId, view);
  const see = (field: string) => canSee(disclosure.fields, `orgItems.${field}`);
  const orgVisible = (orgId: string) => orgInScope(disclosure, orgId);
  // 暂存行不执行，不进预览，也不让目标的既有属性变为可见；但它仍是别的行的挂接目标（见 stagedParents）。
  const visible = visibleItems(disclosure, world.items).items;
  const items = visible.filter((item) => !item.isStaged);
  const targeted = new Set(items.flatMap((item) => (item.targetOrgId && see('targetOrgId') ? [item.targetOrgId] : [])));
  const rangeVisible = canSee(disclosure.fields, 'adjustmentRange');
  const attrsVisible = (orgId: string) => rangeVisible || targeted.has(orgId);

  const subtree = rangeSubtree(world.orgs, view.adjustmentRange);
  const drafts = new Map<string, Draft>();
  for (const orgId of subtree) {
    if (orgVisible(orgId)) drafts.set(orgId, existingDraft(world.orgs.get(orgId)!, attrsVisible(orgId)));
  }
  for (const item of items) overlay(item, drafts, see);
  throughStaged(drafts, stagedParents(visible, see));

  if (drafts.size > PREVIEW_NODE_LIMIT) {
    throw new AppError('PAYLOAD_TOO_LARGE', `预览节点超过 ${PREVIEW_NODE_LIMIT} 个，请缩小调整范围`);
  }
  const existing = [...drafts.values()].flatMap(({ node }) => (node.orgId && attrsVisible(node.orgId) ? [node] : []));
  await fillEstablishment(tx, tenantId, view.effectiveDate, existing);
  await fillHeads(tx, tenantId, [...drafts.values()]);
  const parentOf = (orgId: string) => world.orgs.get(orgId)?.parents.admin?.parentId ?? null;
  const roots = assemble(drafts, view.adjustmentRange, (key) => (subtree.has(key) ? parentOf(key) : null));
  return { adjustmentId: view.id, effectiveDate: view.effectiveDate, roots };
}

type OrgMap = Awaited<ReturnType<typeof loadWorld>>['orgs'];

/**
 * 暂存行不执行、不进预览，但非暂存行可以把它当上级（提交校验 ORG_ADJUSTMENT_STAGED_REFERENCE 才拒绝，F-414①）。
 * 记下每条暂存行自己的上级（看不到新上级时为 null），预览里把挂在暂存行下的节点接到这个上级上。
 */
function stagedParents(items: readonly OrgItem[], see: (field: string) => boolean) {
  const result = new Map<string, string | null>();
  for (const item of items) {
    if (item.isStaged) result.set(item.id, see('parentOrgId') ? (item.parentOrgId ?? item.parentItemId) : null);
  }
  return result;
}

/** 挂接目标是暂存行时沿暂存行的上级链上移，直到落在非暂存行 / 组织上；成环或断链放根层。 */
function throughStaged(drafts: Map<string, Draft>, staged: ReadonlyMap<string, string | null>) {
  if (!staged.size) return;
  for (const draft of drafts.values()) {
    const seen = new Set<string>();
    let key = draft.parentKey;
    while (key && staged.has(key)) {
      if (seen.has(key)) {
        key = null;
        break;
      }
      seen.add(key);
      key = staged.get(key) ?? null;
    }
    draft.parentKey = key;
  }
}

function existingDraft(org: OrgRecord, visible: boolean): Draft {
  const masked = visible ? [] : ['name', ...ATTR_FIELDS];
  return {
    node: node(org.id, org.id, null, visible ? org.name : null, masked),
    parentKey: org.parents.admin?.parentId ?? null,
    sort: { sequence: org.parents.admin?.sequence ?? null, code: org.code, added: 0, tie: org.id },
    head: visible ? org.personInChargeId : null,
  };
}

/** 负责人姓名与组织详情、人员档案同口径：人员版本链的最新姓名（任职头表的姓名不随改名更新）；一次批量查询。 */
export async function headNames(tx: Tx, tenantId: string, ids: readonly string[]) {
  const names = new Map<string, string>();
  if (!ids.length) return names;
  const name = currentPersonName(tenantId, sql`${employmentEmployees.id}`, sql`${employmentEmployees.name}`);
  const rows = await tx
    .select({ id: employmentEmployees.id, name: sql<string>`${name}` })
    .from(employmentEmployees)
    .where(and(eq(employmentEmployees.tenantId, tenantId), inArray(employmentEmployees.id, [...new Set(ids)])));
  for (const row of rows) names.set(row.id, row.name);
  return names;
}

async function fillHeads(tx: Tx, tenantId: string, drafts: readonly Draft[]) {
  const names = await headNames(
    tx,
    tenantId,
    drafts.flatMap((draft) => (draft.head ? [draft.head] : [])),
  );
  for (const draft of drafts) draft.node.personInChargeName = draft.head ? (names.get(draft.head) ?? null) : null;
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
 */
async function fillEstablishment(tx: Tx, tenantId: string, date: string, nodes: readonly PreviewNode[]) {
  const values = await establishmentByOrg(
    tx,
    tenantId,
    date,
    nodes.map((n) => n.orgId!),
  );
  for (const n of nodes) n.establishment = values.get(n.orgId!) ?? null;
}

/** 组织在 date 当天的编制（含下级）；没有编制的组织不在结果里。架构图卡片（F-474-2b）与调整预览共用。 */
export async function establishmentByOrg(tx: Tx, tenantId: string, date: string, ids: readonly string[]) {
  const result = new Map<string, number | null>();
  if (!ids.length) return result;
  const rows = rowsOf<CapacityRow>(
    await tx.execute(sql`SELECT o.id::text AS "objectId", o.org_id::text AS "orgId", o.scheme_id::text AS "schemeId",
        o.period_start::text AS "periodStart", v.inclusive_capacity AS inclusive
      FROM establishment_objects o
      JOIN LATERAL (SELECT inclusive_capacity FROM establishment_versions v
        WHERE v.tenant_id = o.tenant_id AND v.object_id = o.id AND v.start_date <= ${date}::date
        ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1) v ON true
      WHERE o.tenant_id = ${tenantId} AND o.org_id = ANY(${`{${ids.join(',')}}`}::uuid[])
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

function node(key: string, orgId: string | null, itemId: string | null, name: string | null, masked: string[]) {
  const attrs = { personInChargeName: null, establishment: null };
  return { key, orgId, itemId, name, ...attrs, mark: null, masked, children: [] } satisfies PreviewNode;
}

/** 调整范围所选组织及其全部在用下级（行政维度）；所选组织之间互为上下级时只算一次。 */
function rangeSubtree(orgs: OrgMap, range: readonly string[]) {
  const children = new Map<string, string[]>();
  for (const org of orgs.values()) {
    const parentId = org.parents.admin?.parentId;
    if (org.enabled === false || !parentId) continue;
    children.set(parentId, [...(children.get(parentId) ?? []), org.id]);
  }
  const result = new Set<string>();
  const queue = range.filter((id) => orgs.get(id)?.enabled !== false && orgs.has(id));
  while (queue.length) {
    const id = queue.shift()!;
    if (result.has(id)) continue;
    result.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return result;
}

/** 把一条可见明细叠加到树上；看不到的值置 null 并记 masked。 */
function overlay(item: OrgItem, drafts: Map<string, Draft>, see: (field: string) => boolean) {
  const masked = new Set<string>();
  const mark = see('adjustType') ? MARKS[item.adjustType] : (masked.add('adjustType'), null);
  const parentKey = see('parentOrgId') ? (item.parentOrgId ?? item.parentItemId) : (masked.add('parentOrgId'), null);
  const sequence = see('displayOrder') ? item.displayOrder : null;
  const code = see('code') ? item.code : null;
  // 负责人只给 null、不记 masked：保持 10d 预览 masked 的既有口径（名称 / 类型 / 上级），导出看不到同样显示“--”。
  const head = see('personInChargeId') ? item.personInChargeId : null;
  if (item.adjustType === 1) {
    const name = see('name') ? item.name : (masked.add('name'), null);
    drafts.set(item.id, {
      node: { ...node(item.id, null, item.id, name, [...masked]), mark },
      parentKey,
      sort: { sequence, code, added: 1, tie: String(item.seq).padStart(10, '0') },
      head,
    });
    return;
  }
  // 变更 / 停用：目标组织不可见（字段或范围）时不改树，避免经标记或移动间接露出目标。
  const draft = item.targetOrgId && see('targetOrgId') ? drafts.get(item.targetOrgId) : undefined;
  if (!draft) return;
  const target = draft.node as { itemId: string | null } & PreviewNode;
  Object.assign(target, { itemId: item.id, mark });
  // 看不到新名称时保留可见的现名（现名已按既有属性口径给出），masked 记 newName 表示调整后名称未披露；
  // masked 含 name 只留给“名称本身被遮住、name 为 null”的节点，前端据此只有一种解读（F-442）。
  const renamed = see('name') && item.name !== null;
  if (!see('name')) masked.add('newName');
  else if (renamed) target.name = item.name;
  // 新名称本身可见时，原先因调整范围不披露而遮住的名称以新名称为准。
  target.masked = [...new Set([...target.masked.filter((code) => !(renamed && code === 'name')), ...masked])];
  if (item.adjustType === 2 && parentKey) draft.parentKey = parentKey;
  if (item.adjustType === 2 && sequence !== null) draft.sort.sequence = sequence;
  if (item.adjustType === 2 && code !== null) draft.sort.code = code;
  if (item.adjustType === 2 && head !== null) draft.head = head;
}

/** 同级比较：顺序号（空排最后）→ 编码（空排最后）→ 既有在前 → 录入顺序 / 组织 ID。 */
function compareSort(a: SortKey, b: SortKey) {
  const nullsLast = <T>(x: T | null, y: T | null) => (x === null ? (y === null ? 0 : 1) : y === null ? -1 : 0);
  const order = <T>(x: T, y: T) => (x < y ? -1 : x > y ? 1 : 0);
  return (
    nullsLast(a.sequence, b.sequence) ||
    order(a.sequence ?? 0, b.sequence ?? 0) ||
    nullsLast(a.code, b.code) ||
    order(a.code ?? '', b.code ?? '') ||
    a.added - b.added ||
    order(a.tie, b.tie)
  );
}

/**
 * 组装：挂接目标不在树上时沿生效日行政链上找最近的可见祖先（只在调整范围子树内找），找不到放根层；
 * 根层先按调整范围选择顺序，其余按原顺序。防御：挂接成环时断开到根层。
 */
function assemble(drafts: Map<string, Draft>, range: readonly string[], parentOf: (orgId: string) => string | null) {
  const resolve = (start: string | null) => {
    let key = start;
    const seen = new Set<string>();
    while (key && !drafts.has(key) && !seen.has(key)) {
      seen.add(key);
      key = parentOf(key);
    }
    return key && drafts.has(key) ? key : null;
  };
  const parentKey = new Map([...drafts].map(([key, draft]) => [key, resolve(draft.parentKey)]));
  for (const key of drafts.keys()) {
    const seen = new Set([key]);
    for (let up = parentKey.get(key) ?? null; up; up = parentKey.get(up) ?? null) {
      if (seen.has(up)) {
        parentKey.set(key, null);
        break;
      }
      seen.add(up);
    }
  }
  const sorted = [...drafts.values()].sort((a, b) => compareSort(a.sort, b.sort));
  const roots: PreviewNode[] = [];
  for (const draft of sorted) {
    const up = parentKey.get(draft.node.key);
    (up ? drafts.get(up)!.node.children : roots).push(draft.node);
  }
  const rank = (key: string) => {
    const index = range.indexOf(key);
    return index < 0 ? range.length : index;
  };
  return roots
    .map((root, index) => ({ root, index }))
    .sort((a, b) => rank(a.root.key) - rank(b.root.key) || a.index - b.index)
    .map(({ root }) => root);
}
