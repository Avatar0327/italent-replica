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
    (item.parentId === null || typeof item.parentId === 'string')
  );
};
export function acceptCandidates(value: unknown): CandidatePage {
  const page = value as { items?: unknown; hasMore?: unknown } | null;
  if (!page || !Array.isArray(page.items) || !page.items.every(candidate) || typeof page.hasMore !== 'boolean')
    throw new Error(m.invalidReceipt);
  return { items: page.items, hasMore: page.hasMore };
}
export interface CandidateQuery {
  readonly type: ApproverSourceType;
  readonly asOf: string;
  readonly keyword?: string;
  readonly ids?: readonly string[];
}
/** 已选对象按 ID 回查并带上已停用项（DEC-691 D4）；搜索只取启用项且分页上限固定。 */
export function candidateParams({ type, asOf, keyword, ids }: CandidateQuery) {
  const params = new URLSearchParams({ type, asOf });
  if (ids?.length) {
    params.set('ids', ids.join(','));
    params.set('includeInactive', 'true');
  } else {
    params.set('pageSize', String(CANDIDATE_PAGE_SIZE));
    if (keyword) params.set('keyword', keyword);
  }
  return params;
}
export async function readCandidates(api: ApiClient, query: CandidateQuery, signal?: AbortSignal) {
  return acceptCandidates(await api.request<unknown>(`${candidateEndpoint}?${candidateParams(query)}`, { signal }));
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
