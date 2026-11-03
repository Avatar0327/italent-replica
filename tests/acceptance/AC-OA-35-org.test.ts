/**
 * AC-OA-35（组织部分，R2-T08 §2.6 / §8.1）：同单新组织 A、其下 B 以明细引用挂到 A；执行后解析为正式 ID（created_org_id）；
 * A 失败时 B 记 DEPENDENCY_FAILED；A 组提交后崩溃，接管重入不重复创建 A。人员 / 职位行随 11c / 11d。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { execWorld } from './AC-OA-exec-support.js';
import { newOrg } from './AC-OA-items-support.js';
import { resultRows } from './AC-ORG-people-support.js';

const testDb = useTestDb();

async function newPair(w: Awaited<ReturnType<typeof execWorld>>, nameA: string, code?: string) {
  const view = await w.created(w.headBody({ adjustmentRange: [w.a] }));
  const added = await w.item(view.id, newOrg(w.a, { name: nameA, ...(code ? { code } : {}) }));
  const itemA = added.items[0]!.id;
  await w.item(view.id, newOrg(w.a, { name: `${nameA}下级B`, parent: { itemId: itemA } }));
  await w.submitted(view.id);
  await w.acted(view.id, w.hrbp, 'approve');
  await w.acted(view.id, w.head, 'approve');
  return view.id;
}

const namedOrgs = (w: Awaited<ReturnType<typeof execWorld>>, name: string) =>
  withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<{ org_id: string }>(
      await tx.execute(sql`SELECT DISTINCT org_id FROM org_versions WHERE name=${name}`),
    ).map((r) => r.org_id),
  );

describe('AC-OA-35 同单新组织引用', () => {
  it('B 引用 A：执行后 B 的上级是 A 的正式 ID；A 组提交后崩溃，接管不重复创建', async () => {
    const w = await execWorld(testDb().db, 'oa35-ref');
    const id = await newPair(w, 'ZZ_新建A');
    let crashed = false;
    await expect(
      w.run({
        hooks: {
          afterGroup: () => {
            if (crashed) return;
            crashed = true;
            throw new Error('模拟 A 组后崩溃');
          },
        },
      }),
    ).rejects.toThrow('模拟 A 组后崩溃');
    w.advance();
    const resumed = await w.run();

    expect(resumed.completed).toEqual([id]);
    const [a, b] = [...(await w.outcomes(id)).values()];
    expect(a).toMatchObject({ execution_result: 1 });
    expect(b).toMatchObject({ execution_result: 1 });
    expect(await namedOrgs(w, 'ZZ_新建A')).toEqual([a!.created_org_id]);
    expect(await namedOrgs(w, 'ZZ_新建A下级B')).toEqual([b!.created_org_id]);
    expect((await w.orgAt(b!.created_org_id!))!.parent_id).toBe(a!.created_org_id);
    expect(a!.executed_version_id).toBe((await w.orgAt(a!.created_org_id!))!.version_id);
  });

  it('A 执行失败（编码在审批后被占用）→ B 记 DEPENDENCY_FAILED，不创建', async () => {
    const w = await execWorld(testDb().db, 'oa35-dep');
    const code = `ZZC${w.a.replaceAll('-', '').slice(0, 12)}`;
    const id = await newPair(w, 'ZZ_失败A', code);
    const taken = await w.call('POST', '/api/tenant/org/organizations', {
      ifMatch: 0,
      body: { name: 'ZZ_抢占编码', code, establishedOn: '2020-01-01', parents: { admin: { parentId: w.a } } },
    });
    expect(taken.status, await taken.clone().text()).toBe(201);

    await w.run();

    const [a, b] = [...(await w.outcomes(id)).values()];
    expect(a).toMatchObject({ execution_result: 2, created_org_id: null });
    expect(a!.execution_reason).toEqual(expect.any(String));
    expect(b).toMatchObject({ execution_result: 2, execution_reason: 'DEPENDENCY_FAILED', created_org_id: null });
    expect(await namedOrgs(w, 'ZZ_失败A下级B')).toEqual([]);
    expect(await w.headRow(id)).toMatchObject({ success_count: 0, failure_count: 2 });
  });
});
