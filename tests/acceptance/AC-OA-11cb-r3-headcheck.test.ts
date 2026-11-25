/**
 * BE-11c-b 第 3 轮 P2-3（R2-T08 §5.2、§8.2）：新负责人须在本组织的判定里，本单把他的主职调出该组织只替换“主职归属”，
 * 生效日仍有效的兼职要保留（主职 ∪ 兼职），不能把整个并集抹掉。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferWorld } from './AC-OA-11cb-support.js';
import { insertPartTimeRecord } from './AC-PT-support.js';

const testDb = useTestDb();
const noLinkage = { transferOldHeadSubordinates: false, adjustNewHeadManager: false };
const HEAD_NOT_IN_ORG = 'ORG_ADJUSTMENT_HEAD_NOT_IN_ORG';

describe('P2-3 主职调出后仍有效的兼职保留', () => {
  async function headWorld(label: string, partTimeEnd: string | null) {
    const w = await transferWorld(testDb().db, label);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const head = await w.person('B下负责人', w.b); // 主职在 B
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await insertPartTimeRecord(tx, {
        tenantId: w.tenant.id,
        employeeId: head.employeeId,
        departmentId: w.b, // 同时在 B 有兼职
        startDate: '2026-09-01',
        endDate: partTimeEnd,
      });
    });
    await w.item(view.id, {
      entry: 'detail.change',
      adjustType: 2,
      targetOrgId: w.b,
      personInChargeId: head.employeeId,
      ...noLinkage,
    });
    expect((await w.checked(view.id)).errors, '调出前负责人在 B 任职').toEqual([]);
    return { w, view, head };
  }

  it('本单把主职由 B 调到 A，兼职仍在 B 且生效日有效：整单校验不报 HEAD_NOT_IN_ORG', async () => {
    const { w, view, head } = await headWorld('r3-head-parttime-valid', null);

    await w.transfer(view.id, w.transferBody(head.employeeId, { orgId: w.a }));

    expect((await w.checked(view.id)).errors.map((e) => e.reason)).not.toContain(HEAD_NOT_IN_ORG);
  });

  it('兼职已在生效日之前结束：主职调出后确实不在 B，仍报 HEAD_NOT_IN_ORG（对照，不放宽）', async () => {
    const { w, view, head } = await headWorld('r3-head-parttime-ended', '2026-10-15');

    await w.transfer(view.id, w.transferBody(head.employeeId, { orgId: w.a }));

    expect((await w.checked(view.id)).errors.map((e) => e.reason)).toContain(HEAD_NOT_IN_ORG);
  });
});
