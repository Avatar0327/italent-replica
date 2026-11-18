import { RELATION_SOURCE_TYPES, SOURCE_DIMENSIONS, type ApproverSourceType } from '@italent/domain';
import type { ApiClient } from '../../foundation/client.js';
import { m } from './messages.js';
import { s } from './source-messages.js';

/** F-318c c1 / F-380 的候选接口；本片不新增后端端点，形状与 designer-sources.ts 的返回一致。 */
export const candidateEndpoint = '/api/tenant/approval/designer/source-candidates';
export const CANDIDATE_PAGE_SIZE = 50;
export interface SourceCandidate {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly parentId: string | null;
  /** F-326 §5.4：变量（人员多选）与角色列（允许多人）带此键；为 null 时后端整键省略。 */
  readonly multiple?: boolean;
}
export interface CandidatePage {
  readonly items: SourceCandidate[];
  readonly hasMore: boolean;
}
const candidate = (value: unknown): value is SourceCandidate => {
  const item = value as Record<string, unknown> | null;
  return (
    !!item &&
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.enabled === 'boolean' &&
    (item.parentId === null || typeof item.parentId === 'string') &&
    (item.multiple === undefined || typeof item.multiple === 'boolean')
  );
};
export function acceptCandidates(value: unknown): CandidatePage {
  const page = value as { items?: unknown; hasMore?: unknown } | null;
  if (!page || !Array.isArray(page.items) || !page.items.every(candidate) || typeof page.hasMore !== 'boolean')
    throw new Error(m.invalidReceipt);
  return { items: page.items, hasMore: page.hasMore };
}
export interface CandidateQuery {
  readonly context?: 'matrix';
  readonly type: ApproverSourceType;
  readonly asOf: string;
  readonly keyword?: string;
  readonly ids?: readonly string[];
  /** 只有应用变量按审批类型取所属应用（缺省 400）；其余类型不带，避免改变身份等候选的命名值口径。 */
  readonly approvalType?: string;
  readonly page?: number;
  readonly pageSize?: number;
}
/** 已选对象按 ID 回查并带上已停用项（DEC-691 D4）；搜索只取启用项且分页上限固定。 */
export function candidateParams({ type, asOf, keyword, ids, context, approvalType, page, pageSize }: CandidateQuery) {
  const params = new URLSearchParams({ type, asOf });
  if (context) params.set('context', context);
  if (type === 'application_variable' && approvalType) params.set('approvalType', approvalType);
  if (ids?.length) {
    params.set('ids', ids.join(','));
    params.set('includeInactive', 'true');
  } else {
    params.set('pageSize', String(pageSize ?? CANDIDATE_PAGE_SIZE));
    if (page && page > 1) params.set('page', String(page));
    if (keyword) params.set('keyword', keyword);
  }
  return params;
}
export async function readCandidates(api: ApiClient, query: CandidateQuery, signal?: AbortSignal) {
  return acceptCandidates(await api.request<unknown>(`${candidateEndpoint}?${candidateParams(query)}`, { signal }));
}
/** 矩阵候选不按 parentId 过滤（设计 §5.3），两级要整份读取：每页取后端上限 200，最多读 10 页。 */
export const MATRIX_PAGE_SIZE = 200;
export const MATRIX_PAGE_LIMIT = 10;
export async function readMatrixCandidates(api: ApiClient, asOf: string, signal?: AbortSignal) {
  const items: SourceCandidate[] = [];
  for (let page = 1; page <= MATRIX_PAGE_LIMIT; page += 1) {
    const read = await readCandidates(api, { type: 'matrix', asOf, page, pageSize: MATRIX_PAGE_SIZE }, signal);
    items.push(...read.items);
    if (!read.hasMore) return { items, hasMore: false };
  }
  return { items, hasMore: true };
}
/** 按 parentId 组成“矩阵 → 角色列”两级；角色列只挂在列出的矩阵下。 */
export function matrixOptions(items: readonly SourceCandidate[]) {
  const heads = items.filter((item) => item.parentId === null);
  return heads.map((head) => ({ head, columns: items.filter((item) => item.parentId === head.id) }));
}
/** 单人节点主审批人选了多人变量 / 允许多人的角色列：与后端 422 同文提示（source-reference.ts）。 */
export function multipleHint(type: ApproverSourceType, selected: SourceCandidate | undefined, single: boolean) {
  if (!single || !selected?.multiple) return undefined;
  if (type === 'matrix') return s.multipleColumn;
  return type === 'public_variable' || type === 'application_variable' ? s.multipleVariable : undefined;
}
/** 取值方式与领域 relationSource 同源：含下级只给五个组织维度，相对向上只给职务。 */
export function modeOptions(type: ApproverSourceType) {
  if (!RELATION_SOURCE_TYPES.includes(type as (typeof RELATION_SOURCE_TYPES)[number])) return [];
  if (type in SOURCE_DIMENSIONS)
    return [
      { value: 'self', label: s.modes.self },
      { value: 'descendants', label: s.modes.descendants },
    ];
  if (type === 'job')
    return [
      { value: 'self', label: s.jobSelf },
      { value: 'relative', label: s.modes.relative },
    ];
  return [];
}
