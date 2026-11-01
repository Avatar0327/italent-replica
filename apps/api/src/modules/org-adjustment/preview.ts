/**
 * 组织调整预览树（R2-T08 §6.2、§5.6、§4.5；DEC-644；F273A §4；BE-10d 路由 15）。
 * 生效日行政树只取调整范围所选组织及其下级（根按选择顺序），叠加本单明细：新建行以明细 ID 作虚拟节点（added），
 * 变更行标 changed 并按新上级挂接，停用行标 deactivated。已停用的组织不进树；暂存行不执行，不进预览。
 * 裁剪（§4.5）：HR 看不到的组织（组织对象范围外）不出节点，其可见下级挂到最近的可见祖先；被隐去的明细行不出节点
 * 也不改树；看不到的值给 null 并记入 masked。看不到新上级时节点不移动（变更）或放在根层（新建）。
 * 首版不带在岗 / 兼岗 / 编制数（不补“编制原值”，见结果文件“未决 / 假设”），增减数随 11c～11f。
 */
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { scopeAllows } from '../permission/module-access.js';
import { canSee, visibleItems, type Disclosure } from './disclosure.js';
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
  mark: Mark | null;
  masked: string[];
  children: PreviewNode[];
}

interface Draft {
  readonly node: PreviewNode;
  /** 挂接目标：组织 ID 或明细 ID；null = 根层。 */
  parentKey: string | null;
  readonly order: readonly [number, number, string];
}

const MARKS: Readonly<Record<OrgItem['adjustType'], Mark>> = { 1: 'added', 2: 'changed', 3: 'deactivated' };

export async function readPreview(tx: Tx, tenantId: string, disclosure: Disclosure) {
  const view = disclosure.view;
  const world = await loadWorld(tx, tenantId, view);
  const fields = disclosure.fields;
  const see = (field: string) => canSee(fields, `orgItems.${field}`);
  const scope = disclosure.orgScope;
  const orgVisible = (orgId: string) => !scope || scopeAllows(scope, { orgId });
  // 未变更组织的名称属于调整范围的展开：审批人路径跟随 adjustmentRange 的披露，HR 已按组织范围裁过节点。
  const rangeNamesVisible = disclosure.via === 'hr' || canSee(fields, 'adjustmentRange');

  const subtree = rangeSubtree(world.orgs, view.adjustmentRange);
  const drafts = new Map<string, Draft>();
  for (const orgId of subtree) {
    const org = world.orgs.get(orgId)!;
    if (!orgVisible(orgId)) continue;
    drafts.set(orgId, {
      node: node(orgId, orgId, null, rangeNamesVisible ? org.name : null, rangeNamesVisible ? [] : ['name']),
      parentKey: org.parents.admin?.parentId ?? null,
      order: [0, org.displayOrder ?? Number.MAX_SAFE_INTEGER, org.name],
    });
  }

  const items = visibleItems(disclosure, world.items).items.filter((item) => !item.isStaged);
  for (const item of items) overlay(item, drafts, see);

  if (drafts.size > PREVIEW_NODE_LIMIT) {
    throw new AppError('PAYLOAD_TOO_LARGE', `预览节点超过 ${PREVIEW_NODE_LIMIT} 个，请缩小调整范围`);
  }
  const parentOf = (orgId: string) => world.orgs.get(orgId)?.parents.admin?.parentId ?? null;
  const roots = assemble(drafts, view.adjustmentRange, (key) => (subtree.has(key) ? parentOf(key) : null));
  return { adjustmentId: view.id, effectiveDate: view.effectiveDate, roots };
}

function node(key: string, orgId: string | null, itemId: string | null, name: string | null, masked: string[]) {
  return { key, orgId, itemId, name, mark: null, masked, children: [] } satisfies PreviewNode;
}

type OrgMap = Awaited<ReturnType<typeof loadWorld>>['orgs'];

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
  if (item.adjustType === 1) {
    const name = see('name') ? item.name : (masked.add('name'), null);
    drafts.set(item.id, {
      node: { ...node(item.id, null, item.id, name, [...masked]), mark },
      parentKey,
      order: [1, item.seq, item.id],
    });
    return;
  }
  // 变更 / 停用：目标组织不可见（字段或范围）时不改树，避免经标记或移动间接露出目标。
  const draft = item.targetOrgId && see('targetOrgId') ? drafts.get(item.targetOrgId) : undefined;
  if (!draft) return;
  const target = draft.node as { itemId: string | null } & PreviewNode;
  Object.assign(target, { itemId: item.id, mark });
  const renamed = see('name') && item.name !== null;
  if (!see('name')) {
    target.name = null;
    masked.add('name');
  } else if (renamed) target.name = item.name;
  // 新名称本身可见时，原先因调整范围不披露而遮住的名称以新名称为准。
  target.masked = [...new Set([...target.masked.filter((code) => !(renamed && code === 'name')), ...masked])];
  if (item.adjustType === 2 && parentKey) draft.parentKey = parentKey;
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
  const compare = (a: Draft, b: Draft) =>
    a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2].localeCompare(b.order[2]);
  const sorted = [...drafts.values()].sort(compare);
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
