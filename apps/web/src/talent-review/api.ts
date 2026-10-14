import { ApiError, newCommand, type ApiClient, type PageResult } from '../foundation/client.js';
import type { Collection, ReviewRecord } from './types.js';
import { tr } from './messages.js';
export const base = '/api/tenant/talent-review';
/** 列表暂不支持状态筛选。完整读取当前授权结果后才分页，达到上限直接报错，不把截断集合当总数。 */
export async function loadCollection(
  api: ApiClient,
  collection: string,
  signal: AbortSignal,
): Promise<PageResult<ReviewRecord>> {
  const items: ReviewRecord[] = [];
  let hasDataPermission: boolean | undefined;
  for (let page = 1; page <= 20; page++) {
    const result = await api.request<PageResult<ReviewRecord>>(`${base}/${collection}?page=${page}&pageSize=200`, {
      signal,
    });
    items.push(...result.items);
    hasDataPermission = result.hasDataPermission ?? hasDataPermission;
    if (result.hasMore === false || (result.hasMore !== true && result.items.length < 200))
      return { items, total: items.length, hasDataPermission };
  }
  throw new ApiError(413, 'DEMO_LIST_LIMIT', 'conflict', tr.loadLimit);
}
export function saveRecord(
  api: ApiClient,
  collection: Collection,
  body: Record<string, unknown>,
  record?: ReviewRecord,
) {
  return api.request<ReviewRecord>(`${base}/${collection}${record ? `/${record.id}` : ''}`, {
    method: record ? 'PATCH' : 'POST',
    command: newCommand(body, record?.revision ?? 0),
  });
}
