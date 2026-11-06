/**
 * AC-APV-F478-05（S1，设计 §6）：路由、路由条件、激活行都带租户维度并 FORCE RLS；
 * 激活行 append-only（触发器拒绝 UPDATE / DELETE）。本文件在 app_owner（非超级用户）下同样通过。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld } from './AC-APV-support.js';
import { activationsOf, approveTo, otherwise, publishRouted, routeScene, when } from './AC-APV-F478-support.js';

const testDb = useTestDb();

type Rows = { n: number }[];
const rowsOf = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows);

async function stateOf(run: () => Promise<unknown>) {
  try {
    await run();
    return undefined;
  } catch (error) {
    const failure = error as { code?: string; cause?: { code?: string } };
    return failure.code ?? failure.cause?.code ?? 'error';
  }
}

describe('AC-APV-F478-05 租户隔离与激活行只增', () => {
  it('租户 B 读不到租户 A 的路由 / 路由条件 / 激活行，也写不进去', async () => {
    const a = await routeScene(testDb().db, 'f478-05-a');
    const other = await approvalWorld(testDb().db, 'f478-05-b');
    await publishRouted(a.w, a.nodes().slice(0, 3), {
      n1: [approveTo(when(1, 'in', [a.depts.d1, a.depts.d2], 'n3'), otherwise('n2'))],
    });
    const instance = await a.start(a.depts.d1);

    const own = await withTenant(a.w.db, a.w.tenant.id, async (tx) => {
      const routes = rowsOf(await tx.execute(sql`SELECT count(*)::int AS n FROM approval_node_exit_routes`)) as Rows;
      const conds = rowsOf(
        await tx.execute(sql`SELECT count(*)::int AS n FROM approval_node_exit_route_conditions`),
      ) as Rows;
      const acts = rowsOf(await tx.execute(sql`SELECT count(*)::int AS n FROM approval_node_activations`)) as Rows;
      return [routes[0]!.n, conds[0]!.n, acts[0]!.n];
    });
    expect(own[0]).toBe(2);
    expect(own[1]).toBe(1);
    expect(own[2]).toBeGreaterThan(0);

    const foreign = await withTenant(other.db, other.tenant.id, async (tx) => {
      const out: number[] = [];
      for (const table of [
        'approval_node_exit_routes',
        'approval_node_exit_route_conditions',
        'approval_node_activations',
      ]) {
        const result = rowsOf(await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))) as Rows;
        out.push(result[0]!.n);
      }
      return out;
    });
    expect(foreign).toEqual([0, 0, 0]);

    const [first] = await activationsOf(a.w, instance.id);
    const crossWrite = await stateOf(() =>
      withTenant(other.db, other.tenant.id, (tx) =>
        tx.execute(sql`INSERT INTO approval_node_activations
          (tenant_id,activation_id,instance_id,round,node_key,entry_kind,created_seq)
          VALUES (${a.w.tenant.id},gen_random_uuid(),${instance.id}::uuid,1,'n1','start',${first ? 99 : 1})`),
      ),
    );
    expect(crossWrite).toBeDefined();
  });

  it('激活行不可 UPDATE / DELETE（append-only 触发器）', async () => {
    const s = await routeScene(testDb().db, 'f478-05-append');
    await publishRouted(s.w, s.nodes().slice(0, 2), {});
    const instance = await s.start(s.depts.d1);
    expect((await activationsOf(s.w, instance.id)).length).toBeGreaterThan(0);

    const update = await stateOf(() =>
      withTenant(s.w.db, s.w.tenant.id, (tx) =>
        tx.execute(sql`UPDATE approval_node_activations SET node_key='n2' WHERE instance_id=${instance.id}::uuid`),
      ),
    );
    expect(['42501', '55000']).toContain(update);
    const remove = await stateOf(() =>
      withTenant(s.w.db, s.w.tenant.id, (tx) =>
        tx.execute(sql`DELETE FROM approval_node_activations WHERE instance_id=${instance.id}::uuid`),
      ),
    );
    expect(['42501', '55000']).toContain(remove);
    // 触发器本身：连库连接直接 UPDATE / DELETE（不受授权拦截），语句级触发器照样拒绝
    const owner = testDb().db;
    expect(await stateOf(() => owner.execute(sql`UPDATE approval_node_activations SET node_key='n2'`))).toBe('55000');
    expect(await stateOf(() => owner.execute(sql`DELETE FROM approval_node_activations`))).toBe('55000');
  });
});
