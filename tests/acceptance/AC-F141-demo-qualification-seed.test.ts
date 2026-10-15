/**
 * F-141 任职分类（DEC-500）：演示种子补任职资格“层级”候选数据（任职级别的层级下拉来源 /qualification/layers）。
 * 种子经真实接口写入，幂等：再跑一次不重复、不写数据。
 */
import { sql, tenants, eq, withPlatform, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { DEMO_QUALIFICATION_LAYERS } from '../../apps/api/src/demo/data.js';
import { memoryProgress, seedDemo } from '../../apps/api/src/demo/seed.js';
import { actors, options, rowsOf } from './support/demo-seed.js';

const database = useTestDb();
vi.setConfig({ testTimeout: 300_000 });

describe('AC-F141-demo-qualification-seed 演示种子的层级候选（DEC-500）', () => {
  it('首次种入层级候选，层级下拉有来源；再跑一次不重复、不写数据', async () => {
    const db = database().db;
    const progress = memoryProgress();
    expect(DEMO_QUALIFICATION_LAYERS.length).toBeGreaterThanOrEqual(3);

    const first = await seedDemo(db, { ...options, progress });
    expect(first.created).toBe(true);
    const names = async () => {
      const [tenant] = await withPlatform(db, (tx) => tx.select().from(tenants).where(eq(tenants.code, 'demo-r1')));
      return withTenant(db, tenant!.id, async (tx) =>
        rowsOf<{ name: string }>(await tx.execute(sql`SELECT name FROM ql_layers ORDER BY display_order, name`)).map(
          (row) => row.name,
        ),
      );
    };
    expect(await names()).toEqual(DEMO_QUALIFICATION_LAYERS.map((layer) => layer.name));

    // 系统管理员（演示）读 /qualification/layers 能看到候选
    const { persona, send } = await actors(db);
    const page = (await send(await persona('admin'), 'GET', '/api/tenant/qualification/layers?pageSize=50')) as {
      items: { name: string }[];
    };
    expect(page.items.map((row) => row.name).sort()).toEqual(DEMO_QUALIFICATION_LAYERS.map((l) => l.name).sort());

    const second = await seedDemo(db, { ...options, progress });
    expect(second.created).toBe(false);
    expect(await names()).toEqual(DEMO_QUALIFICATION_LAYERS.map((layer) => layer.name));
  });
});
