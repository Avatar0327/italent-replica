/**
 * F-082 AC-23（F082-1 部分）：总开关 formulaIdBinding（契约 §10）。
 * 默认值只在一处定义，F082-1 为 false；依赖注入覆盖只允许作用于 useTestDb() 建的隔离测试库。
 * 不做启用标记或运行时新旧实例互斥（DEC-386）；开关打开时的能力检查与检查脚本见 F082-5。
 */
import { createPgliteDb } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import {
  FORMULA_ID_BINDING_DEFAULT,
  resolveFormulaIdBinding,
} from '../../apps/api/src/modules/talent-review/formula-binding-switch.js';
import type { TenantRouteDeps } from '../../apps/api/src/routes.js';

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

describe('AC-23 总开关：默认关闭', () => {
  it('F082-1 阶段默认值为 false；不传覆盖时路由依赖里的开关就是默认值', () => {
    expect(FORMULA_ID_BINDING_DEFAULT).toBe(false);
    expect(resolveFormulaIdBinding({})).toBe(FORMULA_ID_BINDING_DEFAULT);
    expect(routeDepsOf({ db: testDb().db }).formulaIdBinding).toBe(false);
  });
});

describe('AC-23 DI 隔离：覆盖只作用于隔离测试库', () => {
  it('useTestDb() 建的库可以覆盖开关（打开或显式关闭）', () => {
    expect(routeDepsOf({ db: testDb().db, formulaIdBinding: true }).formulaIdBinding).toBe(true);
    expect(routeDepsOf({ db: testDb().db, formulaIdBinding: false }).formulaIdBinding).toBe(false);
  });

  it('非 useTestDb() 建的库上覆盖开关 → createApp 抛错（不论打开还是关闭）', async () => {
    const stranger = createPgliteDb(new PGlite());
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
