/**
 * F-474-8c-3 社保三项的读取 hook：读取失败一律降级（原值显示“--”、候选为空），不挡表单（AC-INS-04 / 09）。
 * 迟到返回一律作废（第 2 轮 P2-1，DEC-431①）：自动读取按 key 中止、按 key 认领结果；
 * 点击发起的读取用 useTicket 的作废信号，返回后先看信号再写状态或草稿。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  loadCompanyChoices,
  loadInsuranceOrigin,
  loadPlanChoices,
  regionChildren,
  regionName,
  type InsuranceOrigin,
  type RegionNode,
} from './insurance-api.js';
import type { Choice } from './types.js';

/** key 变化或卸载即中止；结果连同 key 落地，只认当前 key，旧 key 的迟到结果不显示。key 为 null 不读取。 */
function useKeyedLoad<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, failed: T) {
  const [loaded, setLoaded] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    const settle = (value: T) => !controller.signal.aborted && setLoaded({ key, value });
    void load(controller.signal).then(settle, () => settle(failed));
    return () => controller.abort();
    // load / failed 随 key 变化，按 key 重读
  }, [key]);
  return loaded?.key === key ? loaded.value : undefined;
}

/**
 * 点击发起的读取（地区选择器的选中 / 下钻）的作废信号：再次发起或 revoke（关闭、换层级、清除）作废上一个；
 * 卸载时在提交阶段同步作废（layout effect），换人等上下文变化随选择器重建一并作废。
 */
export function useTicket() {
  const current = useRef<AbortController | null>(null);
  const revoke = () => current.current?.abort();
  useLayoutEffect(() => () => current.current?.abort(), []);
  const issue = () => {
    revoke();
    current.current = new AbortController();
    return current.current.signal;
  };
  return { issue, revoke };
}

/** 读取中、失败、无权或缺键都返回 null，由界面整体显示“--”，不出现半截原值。 */
export function useInsuranceOrigin(tenantId: string, employeeId: string, effectiveDate: string, businessId?: string) {
  const ready = !!employeeId && !!effectiveDate;
  const query = { employeeId, effectiveDate, ...(businessId ? { businessId } : {}) };
  const key = ready ? [tenantId, employeeId, effectiveDate, businessId ?? ''].join(':') : null;
  const load = (signal: AbortSignal) => loadInsuranceOrigin(tenantId, query, signal);
  return useKeyedLoad<InsuranceOrigin | null>(key, load, null) ?? null;
}

/** 编码 → 字典名称；读取中先显示编码，读不到一直显示编码。 */
export function useRegionName(tenantId: string, code: string | null | undefined) {
  const name = useKeyedLoad(code ? `${tenantId}:${code}` : null, () => regionName(tenantId, code ?? ''), code ?? '');
  return code ? (name ?? code) : '';
}

/** 选择器当前层级的下级列表；parent 为 null 表示未打开，不读取；读取失败显示为空。 */
export function useRegionChildren(tenantId: string, parent: string | null) {
  const key = parent === null ? null : `${tenantId}:${parent}`;
  const load = () => regionChildren(tenantId, parent ?? '');
  return useKeyedLoad<readonly RegionNode[]>(key, load, []) ?? [];
}

/** 方案候选按缴交地 + 生效日读取（AC-INS-04）；没有缴交地时不读取。 */
export function usePlanChoices(tenantId: string, regionCode: string, effectiveDate: string) {
  const key = regionCode && effectiveDate ? `${tenantId}:${regionCode}:${effectiveDate}` : null;
  const load = (signal: AbortSignal) => loadPlanChoices(tenantId, regionCode, effectiveDate, signal);
  return useKeyedLoad<readonly Choice[]>(key, load, []) ?? [];
}

export function useCompanyChoices(tenantId: string) {
  return useKeyedLoad<readonly Choice[]>(tenantId, (signal) => loadCompanyChoices(tenantId, signal), []) ?? [];
}
