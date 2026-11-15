/** F-474-8c-3 社保三项的读取 hook：读取失败一律降级（原值显示“--”、候选为空），不挡表单（AC-INS-04 / 09）。 */
import { useEffect, useState } from 'react';
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

/** 读取中、失败、无权或缺键都返回 null，由界面整体显示“--”，不出现半截原值。 */
export function useInsuranceOrigin(tenantId: string, employeeId: string, effectiveDate: string, businessId?: string) {
  const [origin, setOrigin] = useState<InsuranceOrigin | null>(null);
  useEffect(() => {
    setOrigin(null);
    if (!employeeId || !effectiveDate) return;
    const controller = new AbortController();
    const query = { employeeId, effectiveDate, ...(businessId ? { businessId } : {}) };
    void loadInsuranceOrigin(tenantId, query, controller.signal)
      .then((value) => !controller.signal.aborted && setOrigin(value))
      .catch(() => undefined);
    return () => controller.abort();
  }, [tenantId, employeeId, effectiveDate, businessId]);
  return origin;
}

/** 编码 → 字典名称；读取中先显示编码。 */
export function useRegionName(tenantId: string, code: string | null | undefined) {
  const [name, setName] = useState<{ code: string; name: string } | null>(null);
  useEffect(() => {
    if (!code) return;
    let active = true;
    void regionName(tenantId, code)
      .then((value) => active && setName({ code, name: value }))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [tenantId, code]);
  if (!code) return '';
  return name?.code === code ? name.name : code;
}

/** 选择器当前层级的下级列表；parent 为 null 表示未打开，不读取。 */
export function useRegionChildren(tenantId: string, parent: string | null) {
  const [nodes, setNodes] = useState<{ parent: string; items: readonly RegionNode[] } | null>(null);
  useEffect(() => {
    if (parent === null) return;
    let active = true;
    void regionChildren(tenantId, parent)
      .then((items) => active && setNodes({ parent, items }))
      .catch(() => active && setNodes({ parent, items: [] }));
    return () => {
      active = false;
    };
  }, [tenantId, parent]);
  return nodes && nodes.parent === parent ? nodes.items : [];
}

function useChoices(load: ((signal: AbortSignal) => Promise<Choice[]>) | null, key: string) {
  const [choices, setChoices] = useState<{ key: string; items: readonly Choice[] } | null>(null);
  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    void load(controller.signal)
      .then((items) => !controller.signal.aborted && setChoices({ key, items }))
      .catch(() => !controller.signal.aborted && setChoices({ key, items: [] }));
    return () => controller.abort();
    // load 随 key 变化，按 key 重读
  }, [key]);
  return choices?.key === key ? choices.items : [];
}

/** 方案候选按缴交地 + 生效日读取（AC-INS-04）；没有缴交地时不读取。 */
export function usePlanChoices(tenantId: string, regionCode: string, effectiveDate: string) {
  const ready = !!regionCode && !!effectiveDate;
  const load = ready ? (signal: AbortSignal) => loadPlanChoices(tenantId, regionCode, effectiveDate, signal) : null;
  return useChoices(load, ready ? `${tenantId}:${regionCode}:${effectiveDate}` : '');
}

export function useCompanyChoices(tenantId: string) {
  return useChoices((signal) => loadCompanyChoices(tenantId, signal), tenantId);
}
