/**
 * R2-T03 B3-3 返工 P2-2：批量离职先预锁整批参与员工闭包（离职员工 + 职责转交下属 + 既有联动闭包），按全局 UUID 顺序一次取齐，
 * 再逐人提交。反例：批内 A、B，UUID 顺序 S < A < B，S 是 B 的下属且 B 带“把 S 转交给在职接收人”的计划——
 * 旧实现处理 B 时才发现额外参与人 S（比已登记的 A 更小），整批 409 TRANSFER_LOCK_PLAN_CHANGED，刷新重提仍然失败。
 * 单人入口与批量入口共用同一个闭包计算（exit-lock-plan.ts，DEC-431①）。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { batchItems, dutyPlan, orderedPeople } from './AC-EXIT-batch-support.js';
import { gateWorld } from './AC-EXIT-gate-support.js';

const database = useTestDb();

describe('P2-2 批量离职整批参与员工闭包预锁', () => {
  it('UUID 顺序 S < A < B，B 携带转交下属 S 的计划：整批成功，联动版本与离职申请都保存', async () => {
    const w = await gateWorld(database().db, 'batch-closure');
    const p = await orderedPeople(w);
    const response = await w.session.request('POST', '/exits/batch', {
      body: {
        items: await batchItems(w, [{ id: p.a }, { id: p.b, exit: dutyPlan(p.s, p.receiver) }]),
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { items } = (await response.json()) as { items: { id: string; status: string }[] };
    expect(items.map((business) => business.status)).toEqual(['in_review', 'in_review']);
    const linked = await w.sqlRows<{ business: string }>(
      sql`SELECT business_id::text AS business FROM transfer_linkage_versions
        WHERE tenant_id=${w.session.tenant.id} AND employee_id=${p.b}::uuid`,
    );
    expect(linked.map((row) => row.business)).toEqual([items[1]!.id]);
  });

  it('同一批里转交下属本身也是离职对象、接收人不在批内：闭包去重，仍整批成功', async () => {
    const w = await gateWorld(database().db, 'batch-closure-overlap');
    const p = await orderedPeople(w);
    const response = await w.session.request('POST', '/exits/batch', {
      body: {
        items: await batchItems(w, [{ id: p.s }, { id: p.a }, { id: p.b, exit: dutyPlan(p.s, p.receiver) }]),
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  });
});
