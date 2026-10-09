/**
 * 声明树里的 `map` 型动态选择器（F-039 PR-B2，设计 B-07）：按节点路径 + 字段定位，供 compareSelectors 的五元组核对、
 * 输入来源表的完整性核对与 selector→* 结构弱化共用。位置的写法与 weakenings.ts 的节点路径一致：根节点 `object`，
 * all / any 分支 `of[1].object`，逐行 `rows.operation`，失败审计 `failureAudit.objectType`，可选分支 `optional.<名>.object`。
 * `mapper` / `record` 选择器仍按值域集合相等比较（compare.ts），不在这里。
 */
import type { RoutePolicy } from '@italent/api';

export type BranchField = 'object' | 'operation' | 'button' | 'relation' | 'objectType';

export const BRANCH_FIELDS: readonly BranchField[] = ['object', 'operation', 'button', 'relation', 'objectType'];

export interface SelectorSite {
  /** `节点路径 + 字段`，如 `of[0].object`、`rows.operation`。 */
  readonly position: string;
  readonly field: BranchField;
  readonly from: 'param' | 'body' | 'query';
  readonly path: string;
  readonly map: Readonly<Record<string, unknown>>;
  /** 分支键（排序后）。 */
  readonly keys: readonly string[];
}

type Node = Record<string, unknown>;

function siteOf(position: string, field: BranchField, value: unknown): SelectorSite | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const selector = value as Node;
  const from = selector['from'];
  if ((from !== 'param' && from !== 'body' && from !== 'query') || !selector['map']) return undefined;
  const map = selector['map'] as Record<string, unknown>;
  return { position, field, from, path: String(selector['path']), map, keys: Object.keys(map).sort() };
}

function* nodesWithPath(node: Node, at = ''): Generator<[string, Node]> {
  yield [at, node];
  if (Array.isArray(node['of'])) {
    for (const [i, branch] of (node['of'] as Node[]).entries()) yield* nodesWithPath(branch, `${at}of[${i}].`);
  }
  for (const [name, branch] of Object.entries((node['optional'] as Record<string, Node> | undefined) ?? {})) {
    yield* nodesWithPath(branch, `${at}optional.${name}.`);
  }
}

export function mapSelectors(policy: RoutePolicy): SelectorSite[] {
  const sites: SelectorSite[] = [];
  const add = (site: SelectorSite | undefined) => site && sites.push(site);
  for (const [at, node] of nodesWithPath(policy as unknown as Node)) {
    for (const field of ['object', 'operation', 'button', 'relation'] as const)
      add(siteOf(`${at}${field}`, field, node[field]));
    const rows = node['rows'] as Node | undefined;
    for (const field of ['operation', 'button', 'relation'] as const) {
      add(siteOf(`${at}rows.${field}`, field, rows?.[field]));
    }
    const audit = node['failureAudit'] as Node | undefined;
    add(siteOf(`${at}failureAudit.objectType`, 'objectType', audit?.['objectType']));
  }
  return sites;
}
