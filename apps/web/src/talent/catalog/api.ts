import { newCommand, pageQuery, type ApiClient, type PageRequest, type PageResult } from '../../foundation/client.js';
import type { Resource, Row } from './types.js';
import { m } from './messages.js';

export const resourcePath = (resource: Resource) => `/api/tenant/${resource.module}/${resource.key}`;
export async function listResource(api: ApiClient, resource: Resource, page: PageRequest, query = '') {
  const result = await api.request<PageResult<Row>>(`${resourcePath(resource)}?${pageQuery(page)}${query}`);
  return { ...result, hasMore: result.hasMore ?? result.items.length === page.pageSize };
}
export function writablePatch(
  values: Record<string, unknown>,
  original: Row | null,
  editable: readonly string[],
  nullable: readonly string[] = [],
) {
  return Object.fromEntries(
    Object.entries(values)
      // Select 清空产生 undefined；只把已有且允许清空的字段转换为后端明确的 null 命令。
      .map(([key, value]): [string, unknown] => [
        key,
        value === undefined && original && nullable.includes(key) ? null : value,
      ])
      .filter(
        ([key, value]) =>
          editable.includes(key) &&
          value !== undefined &&
          (!original || (Object.hasOwn(original, key) && JSON.stringify(value) !== JSON.stringify(original[key]))),
      ),
  );
}
export function validateValues(resource: Resource, values: Record<string, unknown>) {
  if (
    'name' in values &&
    (typeof values.name !== 'string' ||
      !values.name.trim() ||
      values.name.trim().length > (resource.module === 'talent' ? 200 : 100))
  )
    throw new Error(m.invalidName);
  if (typeof values.code === 'string' && values.code !== '') {
    const pattern = resource.module === 'talent' ? /^[A-Za-z][A-Za-z0-9_]{0,49}$/ : /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/;
    if (!pattern.test(values.code)) throw new Error(m.invalidCode);
  }
  if (
    values.displayOrder !== undefined &&
    values.displayOrder !== null &&
    (!Number.isInteger(values.displayOrder) ||
      Number(values.displayOrder) < 0 ||
      Number(values.displayOrder) > 1_000_000)
  )
    throw new Error(m.invalidOrder);
}
export async function saveResource(
  api: ApiClient,
  resource: Resource,
  body: Record<string, unknown>,
  original: Pick<Row, 'id' | 'revision'> | null,
) {
  return api.request<Row>(`${resourcePath(resource)}${original ? `/${original.id.toLowerCase()}` : ''}`, {
    method: original ? 'PATCH' : 'POST',
    command: newCommand(body, original?.revision ?? 0),
  });
}
/** 候选逐页读取，不把未加载的尾页伪装成完整集合。 */
export async function candidates(api: ApiClient, path: string, signal: AbortSignal): Promise<Row[]> {
  const result: Row[] = [];
  for (let page = 1; page <= 50; page++) {
    const response = await api.request<PageResult<Row>>(
      `${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=200`,
      { signal },
    );
    result.push(...response.items);
    if (response.items.length < 200) return result;
  }
  throw new Error(m.candidatesLimit);
}

/** QL-R9：只产生引用网格，能力标准内容由后端依 QL-R5 带入。 */
export function newStandardCells(levelIds: string[], targetIds: string[]) {
  return [...new Set(levelIds)].flatMap((levelId) =>
    [...new Set(targetIds)].map((targetId) => ({ levelId, targetId })),
  );
}
