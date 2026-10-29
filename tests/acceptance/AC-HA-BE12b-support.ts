/**
 * BE-12b 人事看板验收夹具：看板接口的客户端（概览 + 指标明细）与“数字 = 明细”断言。
 * 期望值一律是手写的 ID 集合（人员类指标 = 员工 ID，单据类 15–19 = 单据 ID），不拿实现自己的谓词当参照。
 */
import type { Authorizer } from '@italent/api';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { tenantApi } from './support/tenant-api.js';

export const DASHBOARD_BASE = '/api/tenant/analytics/hr-dashboard';

/** 23 个指标（规格 35 §2.1）：序号、编码、明细行的主体。 */
export const INDICATORS = [
  [1, 'regularEmployees', 'employee'],
  [2, 'interns', 'employee'],
  [3, 'entriesThisYear', 'employee'],
  [4, 'leavesThisYear', 'employee'],
  [5, 'probationExpiring30', 'employee'],
  [6, 'contractExpiring30', 'contract'],
  [7, 'probationOverdue', 'employee'],
  [8, 'contractOverdue', 'contract'],
  [9, 'offerPending', 'offer'],
  [10, 'offerSentThisMonth', 'offer'],
  [11, 'entriesThisMonth', 'employee'],
  [12, 'pendingEntries', 'employee'],
  [13, 'regularizedThisMonth', 'employee'],
  [14, 'leavesThisMonth', 'employee'],
  [15, 'offerApproving', 'offer'],
  [16, 'regularizationInProgress', 'business'],
  [17, 'transferInProgress', 'business'],
  [18, 'exitInProgress', 'business'],
  [19, 'contractApproving', 'contract'],
  [20, 'noDirectManager', 'employee'],
  [21, 'noWorkStartDate', 'employee'],
  [22, 'departmentNoHead', 'org'],
  [23, 'departmentNoHrbp', 'org'],
] as const;
export type IndicatorCode = (typeof INDICATORS)[number][1];

export interface Overview {
  asOf: string;
  hasDataPermission: boolean;
  indicators: { no: number; code: IndicatorCode; name: string; subject: string; value: number | null }[];
}
export interface Detail {
  asOf: string;
  code: IndicatorCode;
  no: number;
  name: string;
  subject: string;
  total: number;
  items: { id: string; employeeId: string | null }[];
  page: number;
  pageSize: number;
}

export const sorted = (ids: readonly string[]) => [...ids].sort();

export function dashboardClient(
  db: Db,
  who: { tenant: string; user: string },
  options: { now: () => Date; authorize?: Authorizer },
) {
  const api = tenantApi(db, { clock: options.now, ...(options.authorize ? { authorize: options.authorize } : {}) });
  const get = (path: string) => api.request('GET', path, { user: who.user, tenant: who.tenant });
  const query = (asOf?: string, extra = '') => `${asOf ? `asOf=${asOf}` : ''}${extra}`;

  async function overview(asOf?: string): Promise<Overview> {
    const response = await get(`${DASHBOARD_BASE}?${query(asOf)}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Overview;
  }
  async function page(code: IndicatorCode, asOf?: string, extra = ''): Promise<Detail> {
    const response = await get(`${DASHBOARD_BASE}/indicators/${code}?${query(asOf, extra)}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Detail;
  }
  /** 把明细翻页读完，返回 ID 与服务端报的总数。 */
  async function detail(code: IndicatorCode, asOf?: string) {
    const ids: string[] = [];
    let total = 0;
    for (let n = 1; ; n++) {
      const body = await page(code, asOf, `&page=${n}&pageSize=100`);
      total = body.total;
      ids.push(...body.items.map((item) => item.id));
      if (body.items.length < 100 || ids.length >= total) break;
    }
    return { ids, total };
  }
  /** 数字 = 明细条数 = 期望集合：三者必须是同一个集合。 */
  async function expectIndicator(code: IndicatorCode, expected: readonly string[], asOf?: string) {
    const row = (await overview(asOf)).indicators.find((item) => item.code === code)!;
    const read = await detail(code, asOf);
    expect({ value: row.value, total: read.total, count: read.ids.length }, `${code} 数字 / 总数 / 明细条数`).toEqual({
      value: expected.length,
      total: expected.length,
      count: expected.length,
    });
    expect(sorted(read.ids), `${code} 明细`).toEqual(sorted(expected));
  }
  return { api, get, overview, page, detail, expectIndicator };
}
export type DashboardClient = ReturnType<typeof dashboardClient>;
