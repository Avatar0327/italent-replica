/**
 * F-474-8c-3 调动表单社保三项的读取（设计 F-474-8b §4、§5；接口见 apps/api/src/modules/insurance/routes.ts）。
 * 区划字典全租户同一份、读取无权限要求，按“租户 + 上级编码”缓存；原值、方案、公司随权限与日期变化，不缓存。
 */
import { transferRequest } from './api.js';
import type { Choice } from './types.js';

export const INSURANCE_ORIGIN_PATH = '/api/tenant/transfer/insurance-origin';
const INSURANCE_API = '/api/tenant/insurance';

export interface InsuranceOrigin {
  readonly regionCode: string | null;
  readonly planId: string | null;
  readonly companyId: string | null;
  /** DEC-914：名称随 ID 下发；ID 为 null 或查不到名称时为 null。 */
  readonly planName: string | null;
  readonly companyName: string | null;
}
export interface RegionNode {
  readonly code: string;
  readonly parentCode: string | null;
  readonly level: number;
  readonly name: string;
}
interface Items<T> {
  readonly items: readonly T[];
}
const ORIGIN_KEYS = ['regionCode', 'planId', 'companyId', 'planName', 'companyName'] as const;
const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});

/** 五个键缺任何一个都按读取失败处理（AC-INS-09：不显示半截原值；名称随原值固定下发，DEC-914）。 */
export async function loadInsuranceOrigin(
  tenantId: string,
  query: { employeeId: string; effectiveDate: string; businessId?: string },
  signal?: AbortSignal,
): Promise<InsuranceOrigin> {
  const params = new URLSearchParams({ employeeId: query.employeeId, effectiveDate: query.effectiveDate });
  if (query.businessId) params.set('businessId', query.businessId);
  const origin = await transferRequest<Record<string, unknown>>(tenantId, `${INSURANCE_ORIGIN_PATH}?${params}`, {
    ...signalOf(signal),
  });
  const complete = ORIGIN_KEYS.every((key) => origin[key] === null || typeof origin[key] === 'string');
  if (!complete) throw new Error('incomplete insurance origin');
  return origin as unknown as InsuranceOrigin;
}

const regionCache = new Map<string, Promise<readonly RegionNode[]>>();
/** parent 为空取省级；直辖市区县直接挂在省级编码下（后端只按 parent_code 取下一级）。 */
export function regionChildren(tenantId: string, parent: string): Promise<readonly RegionNode[]> {
  const key = `${tenantId}:${parent}`;
  const cached = regionCache.get(key);
  if (cached) return cached;
  const path = parent ? `${INSURANCE_API}/regions?parent=${parent}` : `${INSURANCE_API}/regions`;
  const loading = transferRequest<Items<RegionNode>>(tenantId, path).then((result) => result.items);
  regionCache.set(key, loading);
  loading.catch(() => regionCache.delete(key));
  return loading;
}

/** 档案存 code、展示名取字典（设计 U6）：按编码规则找可能的上级逐个查；查不到回落为编码本身。 */
export async function regionName(tenantId: string, code: string): Promise<string> {
  const province = `${code.slice(0, 2)}0000`;
  const city = `${code.slice(0, 4)}00`;
  const parents = code === province ? [''] : code === city ? [province] : [province, city];
  for (const parent of parents) {
    const found = (await regionChildren(tenantId, parent)).find((node) => node.code === code);
    if (found) return found.name;
  }
  return code;
}

/** 方案候选：缴交地或其上级、生效日当月有效且启用；planId 列被字段权限去掉的不能选，不列出。 */
export async function loadPlanChoices(tenantId: string, regionCode: string, asOf: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ regionCode, asOf });
  const result = await transferRequest<Items<{ planId?: string; name?: string }>>(
    tenantId,
    `${INSURANCE_API}/plans?${params}`,
    { ...signalOf(signal) },
  );
  return result.items.flatMap((item): Choice[] =>
    item.planId && item.name ? [{ id: item.planId, name: item.name }] : [],
  );
}

export async function loadCompanyChoices(tenantId: string, signal?: AbortSignal) {
  const result = await transferRequest<Items<{ id?: string; name?: string }>>(tenantId, `${INSURANCE_API}/companies`, {
    ...signalOf(signal),
  });
  return result.items.flatMap((item): Choice[] => (item.id && item.name ? [{ id: item.id, name: item.name }] : []));
}
