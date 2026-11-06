/** F-465b：用真实 HTTP 目录/数据/CSV 校验前端适配，不以 UI 合成夹具替代接口联调。 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../apps/web/src/foundation/client.js';
import { initialFilters, reportOf, reportUrl, tablesOf, type ReportData } from '../../apps/web/src/hr-reports/model.js';
import { reportsWorld, AS_OF, allow, PERSON_OBJECT, type ReportsWorld } from './AC-HA-F465a-support.js';
import { reportCatalog } from '../../apps/web/smoke/hr-reports-fixtures.js';
import { parseCsv, stripBom } from './AC-HA-roster-support.js';
const db = useTestDb();
let world: ReportsWorld;
beforeAll(async () => {
  world = await reportsWorld(db().db);
}, 600_000);
afterEach(() => vi.restoreAllMocks());
describe('AC-FE-F465b 真实接口与前端读适配', () => {
  it('目录的 12 个入口逐一查询成功，前端表头和行数直接来自真实响应', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => world.full(String(input)));
    const client = createApiClient(() => ({ tenantId: world.tenantId, identityKey: 'synthetic' }));
    const catalog = await client.request<ReturnType<typeof reportCatalog>>('/api/tenant/hr-analysis/reports');
    expect(catalog).toEqual(reportCatalog());
    for (const item of catalog.items) {
      const report = reportOf(item.code)!;
      expect(report.endpoint).toBe(item.endpoint);
      const result = await client.request<ReportData>(reportUrl(report, initialFilters(item.code, AS_OF), 1));
      const tables = tablesOf(item.code, result);
      if ('items' in result) {
        expect(tables[0]!.columns).toEqual(result.columns);
        expect(tables[0]!.rows).toEqual(result.items);
        expect(tables[0]!.total).toBe(result.total);
      } else {
        const raw = 'tables' in result ? result.tables : [result];
        for (let i = 0; i < raw.length; i++) {
          expect(tables[i]!.columns.slice(1)).toEqual(raw[i]!.columns);
          expect(tables[i]!.total).toBe(raw[i]!.rows.length);
        }
      }
    }
  }, 120_000);
  it('真实字段裁剪、筛选空集、空范围与服务端导出表头保持一致', async () => {
    const read = world.restricted(allow, { personIds: [world.p.old.id], hidden: { [PERSON_OBJECT]: ['mobilePhone'] } });
    const report = reportOf('1.01')!;
    const filters = initialFilters(report.code, AS_OF);
    const result = (await (await read(reportUrl(report, filters, 1))).json()) as ReportData;
    expect(tablesOf(report.code, result)[0]!.columns.some((c) => c.key === 'mobilePhone')).toBe(false);
    const exported = await read(reportUrl(report, filters, undefined, true));
    expect(exported.status).toBe(200);
    expect(parseCsv(stripBom(await exported.text()))[0]).toEqual(
      tablesOf(report.code, result)[0]!.columns.map((c) => c.label),
    );
    const empty = await read(reportUrl(report, { ...filters, name: '绝不匹配的合成姓名' }, 1));
    expect(await empty.json()).toMatchObject({ total: 0, items: [], hasDataPermission: true });
    const noScope = world.restricted(allow, { personIds: [] });
    expect(await (await noScope(reportUrl(report, filters, 1))).json()).toMatchObject({
      total: 0,
      items: [],
      hasDataPermission: false,
    });
  });
});
