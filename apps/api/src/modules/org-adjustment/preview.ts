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
 * F-476 P2：本文件是纯投影——内容源（本单头 / 明细 + 预览输入，见 preview-input.ts）由调用方取：已办读者是办理时冻结份，
 * 其余读现值；这里不再读组织、人员、编制，办理之后的改名、换负责人、改上级、增删明细都不会让已办读者的树漂移。
 */
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { OrgContent } from './content.js';
import { sourceOf } from './detail.js';
import { canSee, orgInScope, visibleItems, type Disclosure } from './disclosure.js';
import type { OrgItem } from './items-store.js';
import { exceedsPreviewLimit, type PreviewOrg, previewTooLarge, type PreviewTree } from './preview-input.js';

export { establishmentByOrg, headNames, pickScheme } from './preview-input.js';

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

/**
 * 预览（路由 15）：取内容源后做纯投影。已办读者读办理时冻结份；冻结份缺预览输入（P1 形状）503，不退回现值（DEC-807）。
 */
export async function readPreview(tx: Tx, tenantId: string, disclosure: Disclosure) {
  return previewOf(await previewSourceOf(tx, tenantId, disclosure), disclosure);
}

export interface PreviewSource {
  readonly content: OrgContent;
  readonly input: PreviewTree;
}

/** 预览 / 导出共用的内容源：现值读一并读预览输入；冻结份必须带预览输入。 */
export async function previewSourceOf(tx: Tx, tenantId: string, disclosure: Disclosure): Promise<PreviewSource> {
  const content = await sourceOf(tx, tenantId, disclosure, { preview: 'live' });
  // 旧办理份（无预览输入）不得用现值补：宁可 503 也不让办理后的改动混进已办读到的树
  if (!content.preview) throw new AppError('SERVICE_UNAVAILABLE', '办理记录暂不可读取，请稍后重试');
  // 办理时已确定读不出来（子树超限 / 编制汇总超预算）：与现值读同码同文案，不退回现值
  if (content.preview.kind === 'refused') throw new AppError(content.preview.code, content.preview.message);
  return { content, input: content.preview };
}

/** 预览投影（纯函数）：披露裁剪、明细叠加、同级排序、组装，全部只依赖内容源与查看人的披露。 */
export function previewOf({ content, input }: PreviewSource, disclosure: Disclosure) {
  const { head } = content;
  const range = content.ranges.map((entry) => entry.orgId);
  const orgs = new Map(input.orgs.map((org) => [org.id, org]));
  const see = (field: string) => canSee(disclosure.fields, `orgItems.${field}`);
  const orgVisible = (orgId: string) => orgInScope(disclosure, orgId);
  // 暂存行不执行，不进预览，也不让目标的既有属性变为可见；但它仍是别的行的挂接目标（见 stagedParents）。
  const visible = visibleItems(disclosure, content.items).items;
  const items = visible.filter((item) => !item.isStaged);
  const targeted = new Set(items.flatMap((item) => (item.targetOrgId && see('targetOrgId') ? [item.targetOrgId] : [])));
  const rangeVisible = canSee(disclosure.fields, 'adjustmentRange');
  const attrsVisible = (orgId: string) => rangeVisible || targeted.has(orgId);

  const drafts = new Map<string, Draft>();
  for (const org of input.orgs) {
    if (orgVisible(org.id)) drafts.set(org.id, existingDraft(org, attrsVisible(org.id)));
  }
  for (const item of items) overlay(item, drafts, see);
  throughStaged(drafts, stagedParents(visible, see));

  if (exceedsPreviewLimit(drafts.size)) throw previewTooLarge();
  // 负责人姓名取输入里的最新姓名；查不到为 null
  for (const draft of drafts.values())
    draft.node.personInChargeName = draft.head ? (input.heads[draft.head] ?? null) : null;
  // 编制原值只给属性可见的既有节点（与负责人同一口径）
  for (const { node } of drafts.values()) {
    const org = node.orgId ? orgs.get(node.orgId) : undefined;
    if (org && attrsVisible(org.id)) node.establishment = org.establishment;
  }
  // 子树之外的组织不参与向上找最近可见祖先（原行为：只在调整范围子树内找）
  const parentOf = (orgId: string) => orgs.get(orgId)?.parentId ?? null;
  const roots = assemble(drafts, range, parentOf);
  return { adjustmentId: head.id, effectiveDate: head.effectiveDate, roots };
}

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

function existingDraft(org: PreviewOrg, visible: boolean): Draft {
  const masked = visible ? [] : ['name', ...ATTR_FIELDS];
  return {
    node: node(org.id, org.id, null, visible ? org.name : null, masked),
    parentKey: org.parentId,
    sort: { sequence: org.sequence, code: org.code, added: 0, tie: org.id },
    head: visible ? org.personInChargeId : null,
  };
}

function node(key: string, orgId: string | null, itemId: string | null, name: string | null, masked: string[]) {
  const attrs = { personInChargeName: null, establishment: null };
  return { key, orgId, itemId, name, ...attrs, mark: null, masked, children: [] } satisfies PreviewNode;
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
