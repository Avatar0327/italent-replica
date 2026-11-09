/**
 * R2-T09b DEC-863② 补转交并入“职责转交”菜单（规格 `30` DT-R5：离职 / 退休人员 3 个月内可在菜单中补转交）：
 * 菜单除当前持有的职责外，还列出落地时被清空、待补转交的职责（来源 2 离职 / 4 退休、接收人为空的清空记录）；
 * 选接收人提交后按普通立即转交执行，清空记录转为已完成并带接收人，之后不再列出；与检查离职退休人员列表同源。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { tenantApi } from './support/tenant-api.js';
import { dutyExitWorld, TODAY, type DutyExitWorld, type ExitKind } from './AC-DT-exit-support.js';

const database = useTestDb();
const world = (label: string) => dutyExitWorld(database().db, label, TODAY);
const EFFECTIVE = '2026-10-21';
const SOURCE = { leave: 2, retirement: 4 } as const;

/** 离职 / 退休落地并清空一个组织负责人 + 一个直线下属；时钟停在落地后第二天。 */
async function clearedWorld(kind: ExitKind) {
  const x = await world(`supplement-${kind}`);
  const org = await x.headedOrg('合成负责人组织');
  const subordinate = await x.subordinateOf(x.employee.id, '合成下属');
  const exit = await x.approvedApplication(kind, '2026-10-20', TODAY);
  await x.activate(exit.id, EFFECTIVE);
  x.setNow(`${EFFECTIVE}T02:00:00Z`);
  return { x, org, subordinate };
}

const clearedItems = async (x: DutyExitWorld) => (await x.duties(x.employee.id)).items.filter((item) => item.cleared);

describe.each(['leave', 'retirement'] as const)('DT-R5 补转交（%s）', (kind) => {
  it('职责转交菜单列出被清空、待补转交的职责，带清空记录标识', async () => {
    const { x, org, subordinate } = await clearedWorld(kind);
    const view = await x.duties(x.employee.id);
    expect(view.total).toBe(2);
    expect(view.items.map((item) => [item.dutyType, item.orgId ?? item.subordinateId, item.pending])).toEqual([
      [1, org.id, null],
      [2, subordinate.id, null],
    ]);
    for (const item of view.items) {
      expect(item.description).not.toBe('');
      expect(item.cleared).toEqual({
        recordId: expect.any(String),
        revision: expect.any(Number),
        source: SOURCE[kind],
      });
    }
  });

  it('选接收人补转交：效果同普通立即转交，清空记录转为已完成，之后不再列出', async () => {
    const { x, org, subordinate } = await clearedWorld(kind);
    const receiver = await x.peer('合成补转交接收人');
    const [orgItem, subItem] = await clearedItems(x);

    const done = await x.submitted(x.employee.id, {
      timing: 'immediate',
      items: [
        {
          dutyType: 1,
          orgId: org.id,
          orgRole: 'person_in_charge',
          receiverId: receiver.id,
          revision: orgItem?.cleared?.revision ?? 1,
        },
        {
          dutyType: 2,
          subordinateId: subordinate.id,
          relation: 'direct',
          receiverId: receiver.id,
          revision: subItem?.cleared?.revision ?? 1,
        },
      ],
    });
    expect(done.count).toBe(2);

    expect(await x.headAt(org.id, EFFECTIVE)).toBe(receiver.id);
    expect(await x.managerOf(subordinate.id, EFFECTIVE)).toBe(receiver.id);
    const records = (await x.records('tab=all')).items.filter((row) => row.employeeId === x.employee.id);
    expect(records).toHaveLength(2);
    for (const row of records)
      expect(row).toMatchObject({
        source: SOURCE[kind],
        status: 1,
        receiverId: receiver.id,
        transferTime: expect.any(String),
      });
    expect((await x.duties(x.employee.id)).items).toEqual([]);
    expect((await x.departed()).items).toEqual([]);
  });

  it('补转交过的职责不能再次提交（已不在待补列表）', async () => {
    const { x, org } = await clearedWorld(kind);
    const receiver = await x.peer('合成补转交接收人');
    const [orgItem] = await clearedItems(x);
    const item = { dutyType: 1 as const, orgId: org.id, orgRole: 'person_in_charge', receiverId: receiver.id };
    await x.submitted(x.employee.id, {
      timing: 'immediate',
      items: [{ ...item, revision: orgItem?.cleared?.revision ?? 1 }],
    });
    const again = await x.submit(x.employee.id, { timing: 'immediate', items: [item] });
    expect(again.status).toBe(400);
    expect((await x.problem(again)).reason).toBe('DUTY_NOT_HELD');
  });
});

describe('DT-R5 补转交的边界', () => {
  it('补转交只支持立即生效：指定日期报 400，清空记录不动', async () => {
    const { x, org } = await clearedWorld('leave');
    const receiver = await x.peer('合成补转交接收人');
    const [orgItem] = await clearedItems(x);
    const response = await x.submit(x.employee.id, {
      timing: 'scheduled',
      transferDate: '2026-10-30',
      items: [
        {
          dutyType: 1,
          orgId: org.id,
          orgRole: 'person_in_charge',
          receiverId: receiver.id,
          revision: orgItem?.cleared?.revision ?? 1,
        },
      ],
    });
    expect(response.status).toBe(400);
    expect((await x.problem(response)).reason).toBe('DUTY_SUPPLEMENT_IMMEDIATE_ONLY');
    expect(await clearedItems(x)).toHaveLength(2);
  });

  it('该组织负责人已另有其人：补转交报 400（职责不空缺），不覆盖现任', async () => {
    const { x, org } = await clearedWorld('leave');
    const other = await x.peer('合成现任负责人');
    const receiver = await x.peer('合成补转交接收人');
    const [orgItem] = await clearedItems(x);
    await assignHead(x, org.id, other.id);

    const response = await x.submit(x.employee.id, {
      timing: 'immediate',
      items: [
        {
          dutyType: 1,
          orgId: org.id,
          orgRole: 'person_in_charge',
          receiverId: receiver.id,
          revision: orgItem?.cleared?.revision ?? 1,
        },
      ],
    });
    expect(response.status).toBe(400);
    expect((await x.problem(response)).reason).toBe('DUTY_SUPPLEMENT_NOT_VACANT');
    expect(await x.headAt(org.id, EFFECTIVE)).toBe(other.id);
  });
});

/** 组织接口从落地日起指定新的负责人（模拟别人已接手）。 */
async function assignHead(x: DutyExitWorld, orgId: string, personId: string) {
  const api = tenantApi(database().db, { clock: () => new Date(`${EFFECTIVE}T02:00:00Z`) });
  const as = { user: x.session.user.id, tenant: x.tenantId };
  const current = await api.request('GET', `/api/tenant/org/organizations/${orgId}`, as);
  const { revision } = (await current.json()) as { revision: number };
  const response = await api.request('PATCH', `/api/tenant/org/organizations/${orgId}`, {
    ...as,
    ifMatch: revision,
    body: { effectiveDate: EFFECTIVE, personInChargeId: personId },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}
