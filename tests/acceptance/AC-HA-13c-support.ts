/**
 * BE-13c 人事流程看板验收夹具：看板接口客户端（概览 + 组件明细）与“数字 = 明细”断言（规格 35 B51）。
 * 期望值一律是手写的 ID 集合（实例类 = 审批实例 ID，任务类 = 审批任务 ID，业务类 = 业务单据 ID），不拿实现自己的谓词当参照。
 */
import type { Authorizer } from '@italent/api';
import type { Db } from '@italent/db';
import type { HrProcessComponentCode } from '@italent/domain';
import { expect } from 'vitest';
import { tenantApi } from './support/tenant-api.js';

export const PROCESS_BASE = '/api/tenant/analytics/hr-process-dashboard';

export interface ProcessGroup {
  key: string;
  label: string | null;
  series: string | null;
  count: number;
  hits: number | null;
  rate: number | null;
  average: number | null;
}
export interface ProcessComponent {
  no: string;
  code: HrProcessComponentCode;
  name: string;
  module: string;
  subject: 'instance' | 'task' | 'business';
  total: number | null;
  hits: number | null;
  /** 副值 ÷ 主值（④ 审批占比，保留 4 位）；主值为 0 时为空。 */
  rate: number | null;
  average: number | null;
  groups: ProcessGroup[];
}
export interface ProcessOverview {
  asOf: string;
  from: string;
  to: string;
  hasDataPermission: boolean;
  components: ProcessComponent[];
}
export interface ProcessItem {
  id: string;
  instanceId: string | null;
  group: string | null;
  series: string | null;
  value: number | null;
  hit: boolean | null;
  [column: string]: unknown;
}
export interface ProcessDetail {
  code: HrProcessComponentCode;
  total: number;
  items: ProcessItem[];
  page: number;
  pageSize: number;
}

/** 明细过滤：组 / 系列 / 是否命中副值。 */
export interface DetailFilter {
  readonly group?: string;
  readonly series?: string;
  readonly hit?: boolean;
}

export const sorted = (ids: readonly string[]) => [...ids].sort();

export function processClient(
  db: Db,
  who: { tenant: string; user: string },
  options: { now: () => Date; authorize?: Authorizer },
) {
  const api = tenantApi(db, { clock: options.now, ...(options.authorize ? { authorize: options.authorize } : {}) });
  const get = (path: string) => api.request('GET', path, { user: who.user, tenant: who.tenant });
  const params = (query: string, filter: DetailFilter = {}) => {
    const extra = new URLSearchParams();
    if (filter.group !== undefined) extra.set('group', filter.group);
    if (filter.series !== undefined) extra.set('series', filter.series);
    if (filter.hit !== undefined) extra.set('hit', String(filter.hit));
    return [query, extra.toString()].filter(Boolean).join('&');
  };

  async function overview(query = ''): Promise<ProcessOverview> {
    const response = await get(`${PROCESS_BASE}?${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as ProcessOverview;
  }
  async function component(code: HrProcessComponentCode, query = '') {
    return (await overview(query)).components.find((item) => item.code === code)!;
  }
  async function page(code: HrProcessComponentCode, query = '', filter: DetailFilter = {}, n = 1) {
    const response = await get(`${PROCESS_BASE}/components/${code}?${params(query, filter)}&page=${n}&pageSize=100`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as ProcessDetail;
  }
  /** 把明细翻页读完。 */
  async function detail(code: HrProcessComponentCode, query = '', filter: DetailFilter = {}) {
    const items: ProcessItem[] = [];
    let total = 0;
    for (let n = 1; ; n++) {
      const body = await page(code, query, filter, n);
      total = body.total;
      items.push(...body.items);
      if (body.items.length < 100 || items.length >= total) break;
    }
    expect(items.length, `${code} 明细条数 = 总数`).toBe(total);
    return items;
  }
  /** 组件主数 = 明细总数 = 期望集合；hits（副值）= hit=true 的明细 = 期望集合。 */
  async function expectComponent(
    code: HrProcessComponentCode,
    expected: { readonly all: readonly string[]; readonly hits?: readonly string[] },
    query = '',
  ) {
    const row = await component(code, query);
    const all = await detail(code, query);
    expect({ total: row.total, detail: sorted(all.map((item) => item.id)) }, `${code} 主数 / 明细`).toEqual({
      total: expected.all.length,
      detail: sorted(expected.all),
    });
    if (expected.hits) {
      const hits = await detail(code, query, { hit: true });
      expect({ hits: row.hits, detail: sorted(hits.map((item) => item.id)) }, `${code} 副值 / 明细`).toEqual({
        hits: expected.hits.length,
        detail: sorted(expected.hits),
      });
    }
    return row;
  }
  /** 一个分组的计数 = 该组明细 = 期望集合。 */
  async function expectGroup(
    code: HrProcessComponentCode,
    key: { readonly group: string; readonly series?: string },
    expected: readonly string[],
    query = '',
  ) {
    const row = await component(code, query);
    const group = row.groups.find((g) => g.key === key.group && (key.series === undefined || g.series === key.series));
    const items = await detail(code, query, key);
    expect(
      { count: group?.count ?? 0, detail: sorted(items.map((item) => item.id)) },
      `${code} 组 ${key.group}/${key.series ?? '-'}`,
    ).toEqual({ count: expected.length, detail: sorted(expected) });
    return group;
  }
  return { api, get, overview, component, page, detail, expectComponent, expectGroup };
}
export type ProcessClient = ReturnType<typeof processClient>;
