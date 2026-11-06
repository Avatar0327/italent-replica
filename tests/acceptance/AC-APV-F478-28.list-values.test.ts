/**
 * AC-APV-F478-28（S1，设计 §2.1 / §3.3）：`in` / `not_in` 的列表值经定义服务真实往返——
 * 列表落 value_list（value_text 为空），单值落 value_text；加载器读回数组；运行时按列表判断，空值对 not_in 为真。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  activationsOf,
  approveCurrent,
  approveTo,
  latestVersionOf,
  otherwise,
  pendingKey,
  publishRouted,
  routeScene,
  when,
} from './AC-APV-F478-support.js';

const testDb = useTestDb();
const rowsOf = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows);

describe('AC-APV-F478-28 列表值往返与运行时', () => {
  it('in / not_in 列表值存 value_list，eq 单值存 value_text，加载器读回数组', async () => {
    const s = await routeScene(testDb().db, 'f478-28-roundtrip');
    const { d1, d2 } = s.depts;
    const process = await publishRouted(s.w, s.nodes().slice(0, 3), {
      n1: [approveTo(when(1, 'in', [d1, d2], 'n3'), when(2, 'not_in', [d1, d2], 'n2'), otherwise('END'))],
      n2: [approveTo(when(1, 'eq', d1, 'n3'), otherwise('END'))],
    });

    const stored = await withTenant(s.w.db, s.w.tenant.id, async (tx) =>
      rowsOf(
        await tx.execute(sql`SELECT node_key,operator,value_text,value_list FROM approval_node_exit_route_conditions
          ORDER BY node_key,branch_no,item_no`),
      ),
    );
    expect(stored).toEqual([
      { node_key: 'n1', operator: 'in', value_text: null, value_list: [d1, d2] },
      { node_key: 'n1', operator: 'not_in', value_text: null, value_list: [d1, d2] },
      { node_key: 'n2', operator: 'eq', value_text: d1, value_list: null },
    ]);

    const version = await latestVersionOf(s.w, process.id);
    const routes = (
      version.nodes[0] as unknown as { routes: { branches: { conditions?: { items: { value: unknown }[] } }[] }[] }
    ).routes;
    expect(routes[0]!.branches[0]!.conditions!.items[0]!.value).toEqual([d1, d2]);
    expect(routes[0]!.branches[1]!.conditions!.items[0]!.value).toEqual([d1, d2]);
  });

  it('运行时：D1 → N3，D3 → N2；缺少部门值时 not_in 为真 → N2', async () => {
    const s = await routeScene(testDb().db, 'f478-28-runtime');
    const { d1, d2 } = s.depts;
    await publishRouted(s.w, s.nodes().slice(0, 3), {
      n1: [approveTo(when(1, 'in', [d1, d2], 'n3'), when(2, 'not_in', [d1, d2], 'n2'), otherwise('END'))],
    });
    expect(pendingKey(await approveCurrent(s, await s.start(d1)))).toBe('n3');
    const third = await approveCurrent(s, await s.start(s.depts.d3));
    expect(pendingKey(third)).toBe('n2');
    expect((await activationsOf(s.w, third.id)).at(-1)).toMatchObject({ from_branch_no: 2 });
    expect(pendingKey(await approveCurrent(s, await s.start(null)))).toBe('n2');
  });
});
