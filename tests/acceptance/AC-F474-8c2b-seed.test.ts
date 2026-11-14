/**
 * F-474-8c-2b 缴交方案种子 / 导入脚本（U4-A；设计 §4.1 / §7）：每租户导入方案头 + 版本，幂等，不跨租户。
 * 方案对运行时角色只读（迁移 0218），脚本以属主身份写、仍带租户上下文；不开维护页面，不加写路由。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedInsurancePlans, type PlanSeed } from '../../scripts/seed-insurance-plans.mjs';
import { count, ownerState, rowsOf, seedInsuranceWorld, sqlState } from './support/insurance-tables.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const seedOf = (): PlanSeed[] => {
  const code = `SEED-${uniqueSuffix()}`;
  return [
    {
      code,
      versions: [
        { name: '一版', regionCode: '440106', effectiveMonth: '2026-01-01', stopMonth: '2026-07-01' },
        { name: '二版', regionCode: '440106', effectiveMonth: '2026-07-01' },
      ],
    },
    {
      code: `${code}-B`,
      versions: [{ name: '停用方案', regionCode: '440100', effectiveMonth: '2026-01-01', enabled: false }],
    },
  ];
};
const counts = async (tenantId: string) => [
  await count(testDb().db, tenantId, 'social_insurance_plans'),
  await count(testDb().db, tenantId, 'social_insurance_plan_versions'),
];
const newTenant = async (label: string) => (await seedInsuranceWorld(testDb().db, label)).tenantId;

describe('缴交方案种子脚本', () => {
  it('首次写入方案头与版本；重复运行什么都不再写（回执给出已存在条数）', async () => {
    const tenantId = await newTenant('seed-idem');
    const [basePlans, baseVersions] = await counts(tenantId);
    const seed = seedOf();
    const first = await seedInsurancePlans(testDb().db, tenantId, seed);
    expect(first).toEqual({ plans: { created: 2, existing: 0 }, versions: { created: 3, existing: 0 } });
    expect(await counts(tenantId)).toEqual([basePlans! + 2, baseVersions! + 3]);
    const again = await seedInsurancePlans(testDb().db, tenantId, seed);
    expect(again).toEqual({ plans: { created: 0, existing: 2 }, versions: { created: 0, existing: 3 } });
    expect(await counts(tenantId)).toEqual([basePlans! + 2, baseVersions! + 3]);
  });

  it('新增一个版本只补写新增的那条；同一生效月内容不同则整批失败、什么都不写', async () => {
    const tenantId = await newTenant('seed-delta');
    const seed = seedOf();
    await seedInsurancePlans(testDb().db, tenantId, seed);
    const before = await counts(tenantId);
    const extended = structuredClone(seed);
    extended[1]!.versions.push({ name: '新版', regionCode: '440100', effectiveMonth: '2026-06-01' });
    expect((await seedInsurancePlans(testDb().db, tenantId, extended)).versions).toEqual({ created: 1, existing: 3 });
    const conflicting = structuredClone(seed);
    conflicting[0]!.versions[0]!.name = '改名';
    conflicting.push({
      code: `NEW-${uniqueSuffix()}`,
      versions: [{ name: 'x', regionCode: '440100', effectiveMonth: '2026-01-01' }],
    });
    await expect(seedInsurancePlans(testDb().db, tenantId, conflicting)).rejects.toThrow(/内容不一致|冲突/);
    expect(await counts(tenantId)).toEqual([before[0], before[1]! + 1]);
  });

  it('不合法的输入整批拒绝：区间重叠、生效月不是 1 号、缴交地不在字典内、空名称', async () => {
    const tenantId = await newTenant('seed-invalid');
    const before = await counts(tenantId);
    const bad: PlanSeed['versions'][] = [
      [
        { name: 'a', regionCode: '440106', effectiveMonth: '2026-01-01' },
        { name: 'b', regionCode: '440106', effectiveMonth: '2026-05-01' },
      ],
      [{ name: 'a', regionCode: '440106', effectiveMonth: '2026-01-15' }],
      [{ name: 'a', regionCode: '999999', effectiveMonth: '2026-01-01' }],
      [{ name: ' ', regionCode: '440106', effectiveMonth: '2026-01-01' }],
    ];
    for (const versions of bad)
      await expect(
        seedInsurancePlans(testDb().db, tenantId, [{ code: `BAD-${uniqueSuffix()}`, versions }]),
      ).rejects.toThrow();
    expect(await counts(tenantId)).toEqual(before);
  });

  it('租户隔离：只写目标租户；别的租户同编码各自独立；非法租户 ID 拒绝', async () => {
    const [a, b] = [await newTenant('seed-a'), await newTenant('seed-b')];
    const seed = seedOf();
    const baseB = await counts(b);
    await seedInsurancePlans(testDb().db, a, seed);
    expect(await counts(b)).toEqual(baseB);
    const second = await seedInsurancePlans(testDb().db, b, seed);
    expect(second.plans.created).toBe(2);
    const ids = async (tenantId: string) =>
      withTenant(testDb().db, tenantId, async (tx) =>
        rowsOf<{ id: string }>(
          await tx.execute(sql`SELECT id FROM social_insurance_plans WHERE code = ${seed[0]!.code}`),
        ),
      );
    expect((await ids(a))[0]!.id).not.toBe((await ids(b))[0]!.id);
    await expect(seedInsurancePlans(testDb().db, 'not-a-uuid', seed)).rejects.toThrow();
    await expect(seedInsurancePlans(testDb().db, randomUUID(), seed)).rejects.toThrow();
  });

  it('运行时角色仍然只读：脚本是写入的唯一入口（经租户路径 INSERT 方案被拒）', async () => {
    const tenantId = await newTenant('seed-readonly');
    const code = `X-${uniqueSuffix()}`;
    const insert = sql`INSERT INTO social_insurance_plans (tenant_id, id, code)
      VALUES (${tenantId}, ${randomUUID()}, ${code})`;
    expect(await sqlState(testDb().db, tenantId, insert)).toBe('42501');
    expect(await ownerState(testDb().db, tenantId, insert)).toBeUndefined();
  });
});
