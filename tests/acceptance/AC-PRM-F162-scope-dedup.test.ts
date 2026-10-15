/** F-162（DEC-516，含 F-159）：其他应用与人员创建范围按去重后的组织数计上限，递归在 d×20,000+1 行处截断。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Tx } from '@italent/db';
import { QUALIFICATION_APP, TALENT_APP } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { expandScopeOrgSet, scopeRows } from '../../apps/api/src/modules/permission/scope-hierarchy.js';
import { personnelCreationScope, resolveDataScope } from '../../apps/api/src/modules/permission/scope-resolver.js';
import { EMPTY_SCOPE, type ScopeQuery } from '../../apps/api/src/modules/permission/scope-types.js';
import { seedTenantWithMember } from './support/tenant-api.js';

const database = useTestDb();
const asOf = '2026-10-01';
const DEPTH = 10;
const LEAVES = 2100;
const LIMIT = 20_000;
const EMPLOYMENT = { appCode: 'TenantBase', objectCode: 'TenantBase.EmploymentRecord' };
const APPS = [EMPLOYMENT, { appCode: QUALIFICATION_APP }, { appCode: TALENT_APP }];

describe('AC-PRM-F162 其他应用与人员创建范围去重计数（DEC-516 / F-159）', () => {
  let tenantId: string;
  let userId: string;
  let chain: string[];
  /** 链首的上级：不在管理单元里，去重展开后也不得带进范围（反向用例）。 */
  let outside: string;
  let leafCount = 0;

  const run = <T>(work: (tx: Tx) => Promise<T>) => withTenant(database().db, tenantId, work);
  /** 造数走库属主事务（同 AC-EV-F107 的 asOwner），避免上万行插入在应用角色下逐行过 RLS。 */
  const owner = (work: (tx: Tx) => Promise<void>) =>
    database().db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      await work(tx);
    });
  const query = (app: { appCode: string; objectCode?: string }): ScopeQuery => ({ tenantId, userId, asOf, ...app });
  const resolve = (app: { appCode: string; objectCode?: string }) => run((tx) => resolveDataScope(tx, query(app)));
  const creation = () =>
    run((tx) =>
      personnelCreationScope(tx, query(EMPLOYMENT), {
        ...EMPTY_SCOPE,
        hasDataPermission: true,
        terms: [{ dimension: 'using_user', creatorId: userId, orgIds: [], personIds: [] }],
      }),
    );

  /** 批量合成停用叶子挂到链尾（停用仍计入范围，DEC-146），避免为上万个叶子逐个走组织 API。 */
  async function addLeaves(count: number) {
    const from = leafCount + 1;
    leafCount += count;
    await owner(async (tx) => {
      await tx.execute(sql`INSERT INTO org_objects(id,tenant_id)
        SELECT md5(${tenantId}||'F162'||g)::uuid,${tenantId} FROM generate_series(${from}::int,${leafCount}::int) g`);
      await tx.execute(sql`INSERT INTO org_versions
        (id,tenant_id,org_id,version_no,start_date,code,name,full_name,enabled)
        SELECT md5(${tenantId}||'F162v'||g)::uuid,${tenantId},md5(${tenantId}||'F162'||g)::uuid,1,'2025-01-01',
        'F162_'||g,'合成组织'||g,'合成组织'||g,false FROM generate_series(${from}::int,${leafCount}::int) g`);
      await tx.execute(sql`ANALYZE org_objects`);
      await tx.execute(sql`ANALYZE org_versions`);
      await tx.execute(sql`INSERT INTO org_hierarchy_links(tenant_id,version_id,dimension,parent_org_id)
        SELECT ${tenantId},md5(${tenantId}||'F162v'||g)::uuid,'admin',${chain[DEPTH - 1]}::uuid
        FROM generate_series(${from}::int,${leafCount}::int) g`);
      await tx.execute(sql`ANALYZE org_hierarchy_links`);
    });
  }

  beforeAll(async () => {
    const seeded = await seedTenantWithMember(database().db, 'f162');
    tenantId = seeded.tenant.id;
    userId = seeded.user.id;
    chain = Array.from({ length: DEPTH }, () => randomUUID());
    outside = randomUUID();
    const person = randomUUID();
    await owner(async (tx) => {
      await tx.execute(sql`INSERT INTO employment_employees(id,tenant_id,code,name)
        VALUES (${person}::uuid,${tenantId},'F162_HRBP','合成HRBP')`);
      await tx.execute(sql`INSERT INTO permission_user_person_links(tenant_id,user_id,employee_id)
        VALUES (${tenantId},${userId}::uuid,${person}::uuid)`);
      for (const [i, orgId] of [outside, ...chain].entries()) {
        const version = randomUUID();
        await tx.execute(sql`INSERT INTO org_objects(id,tenant_id) VALUES (${orgId}::uuid,${tenantId})`);
        await tx.execute(sql`INSERT INTO org_versions
          (id,tenant_id,org_id,version_no,start_date,code,name,full_name,hrbp_id)
          VALUES (${version}::uuid,${tenantId},${orgId}::uuid,1,'2025-01-01',${`F162_C${i}`},${`链${i}`},${`链${i}`},
          ${i === 0 ? null : person}::uuid)`);
        if (i > 0)
          await tx.execute(sql`INSERT INTO org_hierarchy_links(tenant_id,version_id,dimension,parent_org_id)
            VALUES (${tenantId},${version}::uuid,'admin',${i === 1 ? outside : chain[i - 2]}::uuid)`);
      }
      // 一条组织链上的每个上级都勾“包含下级”：展开行 = Σ 子树大小，远超去重后的组织数。
      const [mou] = scopeRows<{ id: string }>(
        await tx.execute(sql`INSERT INTO permission_mous(tenant_id,code,name)
          VALUES (${tenantId},'F162','重叠根管理单元') RETURNING id`),
      );
      for (const orgId of chain)
        await tx.execute(sql`INSERT INTO permission_mou_org_refs(tenant_id,mou_id,org_id,include_descendants)
          VALUES (${tenantId},${mou!.id}::uuid,${orgId}::uuid,true)`);
      for (const { appCode } of APPS)
        await tx.execute(sql`INSERT INTO permission_user_app_scopes(tenant_id,user_id,app_code,kind,mou_id)
          VALUES (${tenantId},${userId}::uuid,${appCode},'mou',${mou!.id}::uuid)`);
    });
    await addLeaves(LEAVES);
  }, 120_000);

  it('AC-PRM-F162 人事 / 任职资格 / 人才档案的管理范围 21,055 行 / 2,110 个组织：完整返回，不再 413', async () => {
    expect(DEPTH * LEAVES + (DEPTH * (DEPTH + 1)) / 2).toBeGreaterThan(LIMIT);
    for (const app of APPS) {
      const scope = await resolve(app);
      expect(scope.all, app.appCode).toBe(false);
      expect(scope.orgIds, app.appCode).toHaveLength(DEPTH + LEAVES);
      expect(new Set(scope.orgIds).size).toBe(DEPTH + LEAVES);
      expect(scope.orgIds).toEqual(expect.arrayContaining(chain));
      expect(scope.orgIds).not.toContain(outside);
    }
  });

  it('AC-PRM-F162 组织 HRBP 规则的重叠根同样按 2,110 个组织计数', async () => {
    await owner(async (tx) => {
      const [policy] = scopeRows<{ id: string }>(
        await tx.execute(sql`INSERT INTO permission_scope_policies
          (tenant_id,app_code,object_code,target_kind,target_code)
          VALUES (${tenantId},${QUALIFICATION_APP},'F162.Object','entity','F162.Object') RETURNING id`),
      );
      await tx.execute(sql`INSERT INTO permission_scope_policy_rules(tenant_id,policy_id,dimension,role_code)
        VALUES (${tenantId},${policy!.id}::uuid,'organization','hrbp')`);
    });
    const scope = await resolve({ appCode: QUALIFICATION_APP, objectCode: 'F162.Object' });
    expect(scope.terms?.map((term) => term.dimension)).toEqual(['organization']);
    expect(scope.orgIds).toHaveLength(DEPTH + LEAVES);
    expect(scope.orgIds).not.toContain(outside);
  });

  it('AC-PRM-F162 人员创建范围（仅“使用用户”规则时改按管理范围）也按去重组织计数', async () => {
    const scope = await creation();
    expect(scope.terms?.map((term) => term.dimension)).toEqual(['management']);
    expect(scope.terms?.[0]?.orgIds).toHaveLength(DEPTH + LEAVES);
    expect(scope.terms?.[0]?.orgIds).not.toContain(outside);
    expect(scope.terms?.[0]?.personQuery?.kind).toBe('organization');
  });

  it('AC-PRM-F162 去重后恰好 20,000 个组织放行，20,001 个组织在各入口仍 413', async () => {
    await addLeaves(LIMIT - DEPTH - LEAVES);
    for (const app of APPS) expect((await resolve(app)).orgIds, app.appCode).toHaveLength(LIMIT);
    expect((await creation()).terms?.[0]?.orgIds).toHaveLength(LIMIT);
    await addLeaves(1);
    for (const app of APPS)
      await expect(resolve(app), app.appCode).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    await expect(creation()).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  }, 120_000);

  it('AC-PRM-F159 子树远超上限时递归在 d×20,000+1 行处停止，不遍历整棵子树再报 413', async () => {
    await addLeaves(10_000);
    const roots = chain.map((orgId) => ({ orgId, dimension: 'admin', includeDescendants: true }));
    const plans: unknown[] = [];
    await run(async (tx) => {
      // 用同一条 SQL 的 EXPLAIN ANALYZE 读递归实际产出的行数；执行本身仍走原语句，结果照常判 413。
      const explaining = new Proxy(tx, {
        get(target, key, receiver) {
          if (key !== 'execute') return Reflect.get(target, key, receiver) as unknown;
          return async (statement: Parameters<Tx['execute']>[0]) => {
            plans.push(...scopeRows(await target.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`)));
            return target.execute(statement);
          };
        },
      });
      await expect(expandScopeOrgSet(explaining, tenantId, asOf, roots)).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
      });
    });
    const unions = recursiveUnionRows(plans);
    expect(unions).toHaveLength(1);
    expect(leafCount + DEPTH).toBeGreaterThan(LIMIT + 10_000 - 1);
    expect(unions[0]).toBeLessThanOrEqual(LIMIT + 1);
  }, 120_000);
});

/** 在 EXPLAIN JSON 计划里收集所有 Recursive Union 节点的实际产出行数。 */
function recursiveUnionRows(plans: unknown[]): number[] {
  const found: number[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record['Node Type'] === 'Recursive Union') found.push(Number(record['Actual Rows']));
    for (const value of Object.values(record)) walk(typeof value === 'string' ? tryParse(value) : value);
  };
  walk(plans);
  return found;
}

function tryParse(value: string): unknown {
  if (!value.startsWith('[')) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
