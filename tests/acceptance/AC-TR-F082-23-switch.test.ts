/**
 * F-082 AC-23（F082-1 部分）：总开关 formulaIdBinding（契约 §10）。
 * 默认值只在一处定义（F082-1 起为 false，F082-5 改为 true）；依赖注入覆盖只允许作用于 useTestDb() 建的隔离测试库。
 * 不做启用标记或运行时新旧实例互斥（DEC-386）；开关打开时的能力检查见 AC-TR-F082-23-capability，检查脚本见
 * AC-TR-F082-23-deploy。F082-5：开关默认 true；改绑路由只在开关打开时注册，关闭时 404（路由与声明都不存在）。
 */
import { createPgDb } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import {
  FORMULA_ID_BINDING_DEFAULT,
  resolveFormulaIdBinding,
} from '../../apps/api/src/modules/talent-review/formula-binding-switch.js';
import type { TenantRouteDeps } from '../../apps/api/src/routes.js';
import { seedOperator } from './support/platform-api.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

/** 取出 createApp 交给租户路由模块的依赖。 */
function routeDepsOf(options: Parameters<typeof createApp>[0]): TenantRouteDeps {
  let captured: TenantRouteDeps | undefined;
  createApp({
    ...options,
    tenantRoutes: [
      (_router, deps) => {
        captured = deps;
      },
    ],
  });
  if (!captured) throw new Error('租户路由模块没有被调用');
  return captured;
}

describe('AC-23 总开关：默认打开（F082-5）', () => {
  it('默认值为 true；不传覆盖时路由依赖里的开关就是默认值', () => {
    expect(FORMULA_ID_BINDING_DEFAULT).toBe(true);
    expect(resolveFormulaIdBinding({})).toBe(FORMULA_ID_BINDING_DEFAULT);
    expect(routeDepsOf({ db: testDb().db }).formulaIdBinding).toBe(true);
  });
});

describe('AC-23 改绑路由只在开关打开时注册', () => {
  const path = '/api/platform/tenants/00000000-0000-4000-8000-000000000000/talent-review/calc-formulas/rebind';
  it('开关关闭 → 404（路由不存在）；开关打开 → 路由存在（租户不存在 404 NOT_FOUND 之前先过请求体校验）', async () => {
    const operator = await seedOperator(testDb().db, 'switch-route');
    const call = (api: ReturnType<typeof tenantApi>) =>
      api.request('POST', path, { user: operator.id, body: { extra: 1 }, idempotencyKey: 'sw-1' });
    const off = await call(tenantApi(testDb().db, { formulaIdBinding: false }));
    expect(off.status).toBe(404);
    expect(((await off.json()) as { error: { message: string } }).error.message).toBe('接口不存在');
    // 开关打开：路由存在，多余字段先被请求体校验拦下（400），不是“接口不存在”
    expect((await call(tenantApi(testDb().db, { formulaIdBinding: true }))).status).toBe(400);
  });
});

describe('AC-23 DI 隔离：覆盖只作用于隔离测试库', () => {
  it('useTestDb() 建的库可以覆盖开关（打开或显式关闭）', () => {
    expect(routeDepsOf({ db: testDb().db, formulaIdBinding: true }).formulaIdBinding).toBe(true);
    expect(routeDepsOf({ db: testDb().db, formulaIdBinding: false }).formulaIdBinding).toBe(false);
  });

  it('非 useTestDb() 建的库上覆盖开关 → createApp 抛错（不论打开还是关闭）', async () => {
    // 不是 useTestDb() 建的库（连接是惰性的，这里不会真的去连）
    const stranger = createPgDb('postgres://stranger@127.0.0.1:1/none');
    try {
      expect(() => createApp({ db: stranger.db, formulaIdBinding: true })).toThrow(/开关/);
      expect(() => createApp({ db: stranger.db, formulaIdBinding: false })).toThrow(/开关/);
      // 不覆盖时照常创建，开关取默认值
      expect(() => createApp({ db: stranger.db })).not.toThrow();
    } finally {
      await stranger.close();
    }
  });

  it('没有数据库时也不允许覆盖开关', () => {
    expect(() => createApp({ formulaIdBinding: true })).toThrow(/开关/);
  });
});
