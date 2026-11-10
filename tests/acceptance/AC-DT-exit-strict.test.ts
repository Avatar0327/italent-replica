/**
 * R2-T09b ① DT-R4 强校验（规格 `30` “补充：强校验实测”，DEC-602②）：
 * 直接离职 / 直接退休时，人员还有职责（下属直线 / 虚线上级、组织负责人 / 店长 / HRBP）未指定接收人 → 409 + 提示原文，
 * 门禁之前不写任何东西；转交计划覆盖全部职责则放行；离职申请（审批流）与直接调动不校验。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { dutyExitWorld, TODAY, type ExitKind } from './AC-DT-exit-support.js';

const database = useTestDb();
const world = (label: string) => dutyExitWorld(database().db, label, TODAY);
const KINDS: readonly ExitKind[] = ['leave', 'retirement'];

describe.each(KINDS)('DT-R4 直接%s：职责未指定接收人', (kind) => {
  const last = '2026-10-20';

  it('还有下属未指定接收人：拒绝并给出提示原文，不写任何东西', async () => {
    const x = await world(`r4-sub-${kind}`);
    const subordinate = await x.subordinateOf(x.employee.id, '合成下属');
    const [before, state] = [await x.writes(), await x.stateOf(x.employee.id)];

    await x.expectRejected(await x.tryDirect(kind, last));

    expect(await x.writes()).toEqual(before);
    expect(await x.stateOf(x.employee.id)).toEqual(state);
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);
  });

  it('担任组织负责人未指定接收人：拒绝', async () => {
    const x = await world(`r4-org-${kind}`);
    await x.headedOrg('合成负责人组织');
    const before = await x.writes();
    await x.expectRejected(await x.tryDirect(kind, last));
    expect(await x.writes()).toEqual(before);
  });

  it('计划只覆盖一部分职责：仍拒绝', async () => {
    const x = await world(`r4-partial-${kind}`);
    const subordinate = await x.subordinateOf(x.employee.id, '合成下属');
    await x.headedOrg('合成负责人组织');
    const receiver = await x.peer('合成接收人');
    const exit = { dutyTransfer: x.plan({ subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id }] }) };
    await x.expectRejected(await x.tryDirect(kind, last, exit));
  });

  it('计划覆盖全部职责：放行，并在生效时按计划转交', async () => {
    const x = await world(`r4-full-${kind}`);
    const subordinate = await x.subordinateOf(x.employee.id, '合成下属');
    const org = await x.headedOrg('合成负责人组织');
    const receiver = await x.peer('合成接收人');
    const exit = {
      dutyTransfer: x.plan({
        subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id }],
        orgRoles: [{ orgId: org.id, receiverId: receiver.id }],
      }),
    };

    const created = await x.createdDirect(kind, last, exit);

    expect(created.status).toBe('approved');
    expect(await x.activate(created.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    expect(await x.items(created.id)).toHaveLength(2);
    expect(await x.managerOf(subordinate.id, '2026-10-21')).toBe(receiver.id);
    expect(await x.headAt(org.id, '2026-10-21')).toBe(receiver.id);
  });

  it('没有任何职责的人：照常放行', async () => {
    const x = await world(`r4-none-${kind}`);
    expect((await x.createdDirect(kind, last)).status).toBe('approved');
  });
});

describe('DT-R4 不适用的入口', () => {
  it('离职申请（审批流）不校验职责：创建、提交、审批通过都成功', async () => {
    const x = await world('r4-application');
    await x.subordinateOf(x.employee.id, '合成下属');
    await x.headedOrg('合成负责人组织');
    const approved = await x.approvedApplication('leave', '2026-10-20', TODAY);
    expect(await x.stateOfBusiness(approved.id)).toBe('approved');
  });

  it('退休申请（审批流）同样不校验', async () => {
    const x = await world('r4-retire-application');
    await x.subordinateOf(x.employee.id, '合成下属');
    const approved = await x.approvedApplication('retirement', '2026-10-20', TODAY);
    expect(await x.stateOfBusiness(approved.id)).toBe('approved');
  });

  it('直接调动不校验职责', async () => {
    const x = await world('r4-transfer');
    await x.subordinateOf(x.employee.id, '合成下属');
    const response = await x.createLeave(x.employee.id, {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-06',
      fields: { departmentId: x.to.id },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  });
});
