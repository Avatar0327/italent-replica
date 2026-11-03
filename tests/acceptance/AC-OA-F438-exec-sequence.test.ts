/**
 * F-438 / DEC-745（R2-T08 §2.2 display_order 行）：审批执行路径同口径——组织调整变更明细（或拖拽）只改上级、
 * displayOrder 为空 = 不变，执行器执行后组织挂到新上级下，行政顺序号沿用原值。
 * 直改 / 明细存空两条见 F-438 自身的 AC-OA-F438-sequence；本文件只覆盖 11b 执行器。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { E, type ExecWorld, execWorld } from './AC-OA-exec-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

/** 在 parent 下建一个带行政顺序号的组织（组织模块写入口）。 */
async function orgWithSequence(w: ExecWorld, parentId: string, sequence: number) {
  const res = await w.call('POST', '/api/tenant/org/organizations', {
    ifMatch: 0,
    body: {
      name: `ZZ_顺序号X${uniqueSuffix()}`,
      establishedOn: '2020-01-01',
      parents: { admin: { parentId, sequence } },
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 组织在某日现行版本的行政上级、行政顺序号与版本显示顺序。 */
const adminLink = (w: ExecWorld, orgId: string, date: string) =>
  withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = resultRows<{ parent_id: string; sequence: number | null; display_order: number | null }>(
      await tx.execute(sql`SELECT h.parent_org_id AS parent_id, h.sequence, v.display_order
        FROM org_versions v JOIN org_hierarchy_links h ON h.version_id=v.id AND h.dimension='admin'
        WHERE v.org_id=${orgId} AND v.start_date<=${date}::date
        ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1`),
    );
    return row!;
  });

/** 明细存的顺序号（空 = 不变，§2.2）。 */
const storedOrders = (w: ExecWorld, adjustmentId: string) =>
  withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<{ display_order: number | null }>(
      await tx.execute(sql`SELECT display_order FROM org_adjustment_org_items
        WHERE adjustment_id=${adjustmentId} ORDER BY seq`),
    ).map((r) => r.display_order),
  );

describe('F-438 / DEC-745 审批执行：只改上级、顺序号为空 → 执行后沿用原顺序号', () => {
  for (const entry of ['detail.change', 'editor.drag'] as const) {
    it(`${entry}：x（原顺序号 30）由 a 挂到 b 下，执行后顺序号仍为 30`, async () => {
      const w = await execWorld(testDb().db, 'f438exec');
      const x = await orgWithSequence(w, w.a, 30);
      const before = await adminLink(w, x, E);
      expect(before).toMatchObject({ parent_id: w.a, sequence: 30 });
      const body = { entry, adjustType: 2, targetOrgId: x, parent: { orgId: w.b }, addEmployment: false };
      const adjustment = await w.approved([w.a, w.b], [body]);
      expect(await storedOrders(w, adjustment.id)).toEqual([null]);

      await w.run();

      const [row] = [...(await w.outcomes(adjustment.id)).values()];
      expect(row).toMatchObject({ execution_result: 1, execution_reason: null });
      expect(await adminLink(w, x, E)).toEqual({ parent_id: w.b, sequence: 30, display_order: before.display_order });
    });
  }
});
