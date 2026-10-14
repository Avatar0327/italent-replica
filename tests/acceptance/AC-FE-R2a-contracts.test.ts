import { describe, expect, it } from 'vitest';
import { appRoute } from '../../apps/web/src/foundation/routes.js';
import { loadSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { type ApiClient, ApiError } from '../../apps/web/src/foundation/client.js';

describe('AC-FE-R2a-01 合同入口与权限', () => {
  it('登记合同入口并使用合同对象授权', () => {
    expect(appRoute('/contracts')?.objectCode).toBe('TenantBase.EmploymentContract');
  });
  it('合同对象无权限时菜单不出现，有权限时出现', async () => {
    for (const allowed of [false, true]) {
      const api = {
        request: async (path: string) => {
          if (path.endsWith('/me/snapshot'))
            return {
              session: { tenantId: 'tenant', userId: 'user' },
              apps: [{ app: 'staff', visible: true, entryObjects: allowed ? ['TenantBase.EmploymentContract'] : [] }],
              scope: [],
              adminMenus: [],
            };
          throw new ApiError(403, 'FORBIDDEN', 'forbidden', '');
        },
      } as unknown as ApiClient;
      const { snapshot } = await loadSnapshot(api, new AbortController().signal);
      expect(snapshot.menus.some((menu) => menu.key === 'contracts')).toBe(allowed);
    }
  });
});

describe('AC-FE-R2a-02 只读请求与申请分流', () => {
  it('六视图只发送已有接口参数，到期天数只用于 expiring', async () => {
    const { listPath, views } = await import('../../apps/web/src/contracts/model.js');
    expect(views.map((view) => view.key)).toEqual([
      'expiring',
      'missing',
      'expired_unrenewed',
      'in_review',
      'valid',
      'all',
    ]);
    for (const { key } of views) {
      const url = new URL(listPath(key, 2, 30), 'https://example.com');
      expect(url.pathname).toBe('/api/tenant/contracts');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        view: key,
        page: '2',
        pageSize: '15',
        ...(key === 'expiring' ? { days: '30' } : {}),
      });
    }
  });
  it('全部中的申请、审批视图和缺失员工不能误入合同详情', async () => {
    const { canOpenRecord } = await import('../../apps/web/src/contracts/model.js');
    expect(canOpenRecord({ id: 'record', rowType: 'contract' }, 'all')).toBe(true);
    expect(canOpenRecord({ id: 'request', rowType: 'request' }, 'all')).toBe(false);
    expect(canOpenRecord({ id: 'unknown-kind' }, 'all')).toBe(false);
    expect(canOpenRecord({ id: 'request' }, 'in_review')).toBe(false);
    expect(canOpenRecord({ employeeId: 'employee' }, 'missing')).toBe(false);
  });
  it('高级筛选仅使用独立合成数据，日期区间和类型可组合', async () => {
    const { previewContracts } = await import('../../apps/web/src/demo-stubs/contracts.js');
    const rows = previewContracts(
      { name: '合成甲', typeId: ['demo-labor'], from: '2027-01-01', to: '2027-12-31' },
      'all',
    );
    expect(rows.map((row) => row.id)).toEqual(['demo-contract-a']);
    expect(previewContracts({ name: '不存在' }, 'all')).toEqual([]);
  });
});
