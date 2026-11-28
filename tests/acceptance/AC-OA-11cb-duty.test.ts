/**
 * BE-11c-b 职责转交（R2-T08 §6.3，AC-OA-11）与引用保护：
 * 部门负责人调动并勾选职责转交 → 生效日落地后组织负责人与直线下属都交接给接收人；
 * 删除被调动明细引用为目标部门的同单新增组织行 → 409，调动行不悬空。
 */
import { runEmploymentActivations } from '@italent/api';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { findCurrentRecord } from '../../apps/api/src/modules/employment/read-model.js';
import { transferWorld } from './AC-OA-11cb-support.js';
import { expectError } from './AC-OA-head-support.js';
import { newOrg } from './AC-OA-items-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { uniqueSuffix } from './support/unique.js';
import { cmd } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-OA-11 部门负责人调动 + 职责转交', () => {
  it('生效日落地后：组织负责人与直线下属都交接给接收人，调动人任职已在目标部门', async () => {
    const w = await transferWorld(testDb().db, 'oa11-duty');
    const mover = await w.staff(w.a);
    const receiver = await w.staff(w.b);
    const created = await w.call('POST', '/api/tenant/org/organizations', {
      ifMatch: 0,
      body: {
        name: `ZZ_负责人组织${uniqueSuffix()}`,
        establishedOn: '2020-01-01',
        parents: { admin: { parentId: w.a } },
        personInChargeId: mover,
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const headed = ((await created.json()) as { id: string }).id;
    const subordinate = await w.employee(`ZZ_下属${uniqueSuffix()}`);
    await w.hire(subordinate.id, { departmentId: w.a, directManagerId: mover });
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const dutyTransfer = {
      subordinates: [{ employeeId: subordinate.id, receiverId: receiver, relation: 'direct' }],
      orgRoles: [{ orgId: headed, role: 'person_in_charge', receiverId: receiver }],
    };
    await w.transfer(view.id, w.transferBody(mover, { orgId: w.b }, { linkage: { dutyTransfer } }));
    await w.submitted(view.id);
    await w.acted(view.id, w.hrbp, 'approve');
    await w.acted(view.id, w.head, 'approve');

    await w.run();
    await runEmploymentActivations(
      testDb().db,
      cmd(),
      { tenantId: w.tenant.id },
      { clock: () => new Date('2026-11-01T12:00:00Z') },
    );

    const [row] = await w.transferRows(view.id);
    expect(row, JSON.stringify(row)).toMatchObject({ execution_result: 1 });
    expect((await w.currentRecord(mover))!.department_id).toBe(w.b);
    const manager = await w.inTenant(
      async (tx) =>
        (await findCurrentRecord(tx, w.tenant.id, subordinate.id, '2026-11-02'))?.fields.directManagerId ?? null,
    );
    expect(manager, '直线下属交接给接收人').toBe(receiver);
    const head = await w.inTenant(async (tx) =>
      resultRows<{ person_in_charge_id: string | null }>(
        await tx.execute(sql`SELECT person_in_charge_id FROM org_versions WHERE org_id = ${headed}
          ORDER BY version_no DESC LIMIT 1`),
      ),
    );
    expect(head[0]!.person_in_charge_id, '组织负责人交接给接收人').toBe(receiver);
  });
});

describe('调动明细引用保护', () => {
  it('同单新增组织被调动明细引用为目标部门：删除该组织行 409 ITEM_REFERENCED，两行原样保留', async () => {
    const w = await transferWorld(testDb().db, 'oa-ref-guard');
    const mover = await w.staff(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const created = await w.item(view.id, newOrg(w.a, { name: `ZZ_被引用组织${uniqueSuffix()}` }));
    const orgItemId = created.items[0]!.id;
    await w.transfer(view.id, w.transferBody(mover, { itemId: orgItemId }));

    const res = await w.deleteItem(view.id, orgItemId);

    await expectError(res, 409, 'CONFLICT', 'ORG_ADJUSTMENT_ITEM_REFERENCED');
    expect(await w.transferRows(view.id)).toHaveLength(1);
    expect((await w.rows(view.id)).length).toBeGreaterThan(0);
  });
});
